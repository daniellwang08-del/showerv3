export const MATCH_FILTERS = [
  {
    value: '0',
    label: 'Any match',
    hint: 'Show every job in this list, including low scores.',
  },
  {
    value: '50',
    label: 'Fair+ (50)',
    hint: 'Only rows scoring 50 or higher in this list.',
  },
  {
    value: '65',
    label: 'Good+ (65)',
    hint: 'Only rows scoring 65 or higher in this list.',
  },
  {
    value: '80',
    label: 'Strong (80+)',
    hint: 'Only strong matches (80+) in this list.',
  },
] as const;
