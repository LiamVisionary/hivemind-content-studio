// The cheapest gate this package has: `no-undef` over src/.
//
// A one-line missing import — ModelSourcePicker calling `rememberModelUse`
// without importing it (2026-09-02) — takes a whole studio down at runtime, and
// none of the 1111 node tests mount a component, so nothing caught it for a
// week. eslint reads every file in seconds and names that class exactly.
//
// Deliberately core rules only: eslint-plugin-react is not a declared
// dependency here, so nothing in this config may assume it. JSX is parsed (so
// the files load) and `react/jsx-uses-vars` is stood in for by treating
// JSX-only identifiers as used — see the no-unused-vars options below.
import js from '@eslint/js';
import globals from 'globals';

// The source carries `eslint-disable-next-line react-hooks/exhaustive-deps` and
// `jsx-a11y/media-has-caption` comments from before this config existed. eslint
// fails a file whose disable comment names a rule it cannot find, so those
// plugin namespaces are declared here with rules that check nothing: the
// comments stay valid, and the day those plugins become real dependencies these
// stubs are what get deleted.
const stubNamespace = (names) => ({
  rules: Object.fromEntries(names.map((name) => [name, { create: () => ({}) }])),
});

// `no-undef` does not see JSX element names — core eslint never turns
// `<Icon />` into a reference, which is what `react/jsx-no-undef` exists for in
// the plugin this package deliberately does not depend on. So a component
// rendered without being imported is the one shape of missing import that both
// the lint gate and a smoke render can miss: the render only reaches the
// branches it paints. Thirty lines of scope lookup close it.
const jsxScope = {
  rules: {
    'no-undef': {
      meta: { schema: [] },
      create(context) {
        const sourceCode = context.sourceCode || context.getSourceCode();
        const resolves = (node, name) => {
          for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
            if (scope.set.has(name)) return true;
            if (scope.through.some((ref) => ref.identifier.name === name && ref.resolved)) return true;
          }
          // Globals live on the module's outermost scope.
          const globalScope = sourceCode.scopeManager.globalScope;
          return Boolean(globalScope && globalScope.set.has(name));
        };
        return {
          JSXOpeningElement(node) {
            let name = node.name;
            while (name.type === 'JSXMemberExpression') name = name.object;
            if (name.type !== 'JSXIdentifier') return; // namespaced <svg:a>
            // Lowercase is an intrinsic element (<div>), not a binding.
            if (!/^[A-Z_$]/.test(name.name)) return;
            if (resolves(node, name.name)) return;
            context.report({ node: name, message: `'${name.name}' is rendered but never defined or imported.` });
          },
        };
      },
    },
  },
};

export default [
  {
    ignores: ['dist/**', 'build/**', 'release/**', 'node_modules/**', 'public/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    plugins: {
      'react-hooks': stubNamespace(['exhaustive-deps', 'rules-of-hooks']),
      'jsx-a11y': stubNamespace(['media-has-caption']),
      react: stubNamespace(['no-array-index-key']),
      jsx: jsxScope,
    },
    linterOptions: {
      // The stub above reports nothing, so every directive it covers would
      // otherwise read as unused.
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        // Replaced at build time by vite.config.mjs, which reads the one version
        // number in pyproject.toml. `src/lib/appVersion.js` is the only reader
        // and treats its absence (node --test, a bare import) as "ask the API".
        __APP_VERSION__: 'readonly',
      },
    },
    rules: {
      // The two that catch real breakage. Everything stylistic stays off: this
      // is a gate, not a formatter, and a gate nobody can pass is a gate nobody
      // keeps green.
      'no-undef': 'error',
      // The JSX half of the same gate — see jsxScope above.
      'jsx/no-undef': 'error',
      // Advisory, not a gate. Without the react plugin a component imported for
      // JSX alone reads as unused, so imports are not checked at all here; what
      // is left — a dead local — is worth saying and not worth failing a build
      // over, least of all one whose file is mid-edit in another branch.
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^[A-Z_]',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
