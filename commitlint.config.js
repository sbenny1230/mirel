// Conventional Commits: https://www.conventionalcommits.org
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow descriptive bodies and long trailers (e.g. Co-Authored-By).
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
