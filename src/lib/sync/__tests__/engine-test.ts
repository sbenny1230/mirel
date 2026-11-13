import { generateSpaceKey, getSodium, type Sodium } from '../../crypto';
import { MemoryKeyRing, MemoryLocalStore, SyncEngine, type Entity } from '..';
import { FakeServer, type FakeTransport } from '../testing/fake-server';

const SPACE = 'space-a';

let sodium: Sodium;
beforeAll(async () => {
  sodium = await getSodium();
});

interface Device {
  engine: SyncEngine;
  store: MemoryLocalStore;
  transport: FakeTransport;
  keyring: MemoryKeyRing;
  clock: { t: number };
}

let spaceKey: Uint8Array;
let server: FakeServer;
let idCounter = 0;

beforeEach(() => {
  spaceKey = generateSpaceKey(sodium);
  server = new FakeServer();
});

async function device(name: string, opts: { withKey?: boolean; pageSize?: number } = {}): Promise<Device> {
  const store = new MemoryLocalStore();
  const keyring = new MemoryKeyRing();
  if (opts.withKey !== false) keyring.add(SPACE, 1, spaceKey);
  const transport = server.transport();
  const clock = { t: 1_000_000 };
  const engine = new SyncEngine({
    sodium,
    store,
    transport,
    keyring,
    deviceId: name,
    generateId: () => `${name}-${++idCounter}`,
    now: () => clock.t,
    pullPageSize: opts.pageSize,
  });
  await engine.init();
  return { engine, store, transport, keyring, clock };
}

const fieldsOf = (d: Device, id: string) => d.engine.get(id)?.fields;
const snapshot = (d: Device) =>
  d.engine
    .list()
    .map((e: Entity) => ({ id: e.id, kind: e.kind, fields: e.fields }))
    .sort((a, b) => a.id.localeCompare(b.id));

describe('SyncEngine', () => {
  it('creates offline, then syncs to another device', async () => {
    const phone = await device('phone');
    const laptop = await device('laptop');
    phone.transport.online = false;

    const id = await phone.engine.create(SPACE, 'person', { name: 'Alex', birthday: '1994-06-02' });
    expect(fieldsOf(phone, id)).toEqual({ name: 'Alex', birthday: '1994-06-02' });

    const offline = await phone.engine.sync();
    expect(offline.ok).toBe(false);
    expect(await phone.engine.pendingCount()).toBe(1);

    phone.transport.online = true;
    expect((await phone.engine.sync()).pushed).toBe(1);
    expect(await phone.engine.pendingCount()).toBe(0);

    await laptop.engine.sync();
    expect(laptop.engine.get(id)).toEqual({ id, spaceId: SPACE, kind: 'person', fields: { name: 'Alex', birthday: '1994-06-02' } });
  });

  it('never sends plaintext (or even the record kind) to the server', async () => {
    const phone = await device('phone');
    await phone.engine.create(SPACE, 'gift_idea', { title: 'Fleetwood Mac vinyl', price: 32 });
    await phone.engine.sync();
    const stored = JSON.stringify([...server.records.values()]);
    expect(stored).not.toMatch(/Fleetwood|gift_idea|title|price/);
  });

  it('merges concurrent offline edits to different fields', async () => {
    const phone = await device('phone');
    const laptop = await device('laptop');
    const id = await phone.engine.create(SPACE, 'person', { name: 'Sam', nickname: null, notes: '' });
    await phone.engine.sync();
    await laptop.engine.sync();

    phone.clock.t += 10;
    laptop.clock.t += 20;
    await phone.engine.update(id, { nickname: 'Sammy' });
    await laptop.engine.update(id, { notes: 'Allergic to peanuts' });

    await phone.engine.sync();
    const res = await laptop.engine.sync(); // conflict → merged on device → re-pushed
    expect(res.ok).toBe(true);
    expect(res.conflictsMerged).toBeGreaterThan(0);
    await phone.engine.sync();

    const expected = { name: 'Sam', nickname: 'Sammy', notes: 'Allergic to peanuts' };
    expect(fieldsOf(phone, id)).toEqual(expected);
    expect(fieldsOf(laptop, id)).toEqual(expected);
  });

  it('resolves same-field conflicts with the latest edit, regardless of sync order', async () => {
    const phone = await device('phone');
    const laptop = await device('laptop');
    const id = await phone.engine.create(SPACE, 'note', { body: 'v0' });
    await phone.engine.sync();
    await laptop.engine.sync();

    phone.clock.t += 100;
    await phone.engine.update(id, { body: 'later edit (phone)' });
    laptop.clock.t += 50;
    await laptop.engine.update(id, { body: 'earlier edit (laptop)' });

    // The earlier edit reaches the server first; the later one must still win.
    await laptop.engine.sync();
    await phone.engine.sync();
    await laptop.engine.sync();

    expect(fieldsOf(phone, id)).toEqual({ body: 'later edit (phone)' });
    expect(fieldsOf(laptop, id)).toEqual({ body: 'later edit (phone)' });
  });

  it('delete wins over a concurrent edit (both orders) and drops content from the server', async () => {
    for (const deleterFirst of [true, false]) {
      server = new FakeServer();
      const a = await device('a');
      const b = await device('b');
      const id = await a.engine.create(SPACE, 'note', { body: 'secret' });
      await a.engine.sync();
      await b.engine.sync();

      await a.engine.remove(id);
      await b.engine.update(id, { body: 'edited' });
      const [first, second] = deleterFirst ? [a, b] : [b, a];
      await first.engine.sync();
      await second.engine.sync();
      await first.engine.sync();

      expect(a.engine.get(id)).toBeUndefined();
      expect(b.engine.get(id)).toBeUndefined();
      expect(server.records.get(id)).toMatchObject({ deleted: true, ciphertext: null });
    }
  });

  it('keeps an edit made while a push is in flight', async () => {
    const phone = await device('phone');
    const laptop = await device('laptop');
    const id = await phone.engine.create(SPACE, 'note', { body: 'first' });

    const realPush = phone.transport.push.bind(phone.transport);
    let editDuringPush: Promise<void> | undefined;
    phone.transport.push = async (changes) => {
      const results = await realPush(changes);
      phone.clock.t += 1;
      editDuringPush ??= phone.engine.update(id, { body: 'second' });
      return results;
    };

    await phone.engine.sync();
    await editDuringPush;
    expect(await phone.engine.pendingCount()).toBe(1);

    await phone.engine.sync();
    await laptop.engine.sync();
    expect(fieldsOf(laptop, id)).toEqual({ body: 'second' });
  });

  it('pulls in pages', async () => {
    const phone = await device('phone');
    for (let i = 0; i < 25; i++) await phone.engine.create(SPACE, 'note', { body: `n${i}` });
    await phone.engine.sync();
    const laptop = await device('laptop', { pageSize: 10 });
    expect((await laptop.engine.sync()).pulled).toBe(25);
    expect(laptop.engine.list('note')).toHaveLength(25);
    expect((await laptop.engine.sync()).pulled).toBe(0);
  });

  it('restores state from the local store after a restart', async () => {
    const phone = await device('phone');
    const id = await phone.engine.create(SPACE, 'person', { name: 'Grandad' });
    const restarted = new SyncEngine({
      sodium,
      store: phone.store,
      transport: phone.transport,
      keyring: phone.keyring,
      deviceId: 'phone',
      generateId: () => 'x',
    });
    await restarted.init();
    expect(restarted.get(id)?.fields).toEqual({ name: 'Grandad' });
    expect(await restarted.pendingCount()).toBe(1);
  });

  it('holds undecryptable records until the key arrives', async () => {
    const phone = await device('phone');
    const id = await phone.engine.create(SPACE, 'note', { body: 'hi' });
    await phone.engine.sync();

    const newDevice = await device('new', { withKey: false });
    newDevice.keyring.add(SPACE, 99, generateSpaceKey(sodium)); // wrong key so the space is listed
    await newDevice.engine.sync();
    expect(newDevice.engine.get(id)).toBeUndefined();

    newDevice.keyring.add(SPACE, 1, spaceKey);
    await newDevice.engine.refreshLocked();
    expect(newDevice.engine.get(id)?.fields).toEqual({ body: 'hi' });
  });

  it('rejects ciphertext the server moved to another record', async () => {
    const phone = await device('phone');
    const a = await phone.engine.create(SPACE, 'note', { body: 'A' });
    const b = await phone.engine.create(SPACE, 'note', { body: 'B' });
    await phone.engine.sync();
    // Malicious server swaps ciphertexts between records.
    const ra = server.records.get(a)!;
    const rb = server.records.get(b)!;
    server.records.set(a, { ...ra, ciphertext: rb.ciphertext, seq: 100 });
    const laptop = await device('laptop');
    await laptop.engine.sync();
    expect(laptop.engine.get(a)).toBeUndefined();
    expect(laptop.engine.get(b)?.fields).toEqual({ body: 'B' });
  });

  it('converges across three devices under random offline edits', async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const devices = await Promise.all(['d1', 'd2', 'd3'].map((n) => device(n)));

    for (let step = 0; step < 300; step++) {
      const d = devices[rand(3)]!;
      d.clock.t += rand(5);
      const existing = d.engine.list();
      const op = rand(10);
      if (op < 3 || existing.length === 0) {
        await d.engine.create(SPACE, 'note', { body: `s${step}`, tag: rand(3) });
      } else if (op < 8) {
        const target = existing[rand(existing.length)]!;
        await d.engine.update(target.id, rand(2) ? { body: `s${step}` } : { tag: rand(3) });
      } else if (op < 9) {
        await d.engine.remove(existing[rand(existing.length)]!.id);
      } else {
        d.transport.online = rand(4) !== 0;
        await d.engine.sync();
      }
    }

    for (const d of devices) d.transport.online = true;
    for (let round = 0; round < 3; round++) for (const d of devices) expect((await d.engine.sync()).ok).toBe(true);

    const [first, ...rest] = devices.map(snapshot);
    expect(first!.length).toBeGreaterThan(0);
    for (const s of rest) expect(s).toEqual(first);
    for (const d of devices) expect(await d.engine.pendingCount()).toBe(0);
  });
});
