import next from 'eslint-config-next';
export default [...next, { ignores: ['.next/**', 'node_modules/**'] }, {
  rules: { 'react-hooks/set-state-in-effect': 'off', 'react-hooks/purity': 'off' },
}];
