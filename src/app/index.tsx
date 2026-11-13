import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

// Placeholder until the auth + vault + Today screens land.
export default function HomeScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.content}>
        <ThemedText type="title">Mirel</ThemedText>
        <ThemedText>Be intentional with the people you love.</ThemedText>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three, padding: Spacing.four },
});
