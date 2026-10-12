export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'scope-enum': [
      2,
      'always',
      [
        'web',
        'api',
        'worker',
        'db',
        'agent',
        'compiler',
        'credit',
        'provider',
        'queue',
        'skills',
        'docs',
      ],
    ],
    'subject-empty': [2, 'never'],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore', 'revert'],
    ],
  },
};
