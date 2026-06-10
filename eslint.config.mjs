import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			eqeqeq: "error",
			"@typescript-eslint/switch-exhaustiveness-check": "error",
		},
	},
	{
		// Test code is excluded from tsconfig (it must not compile into dist/),
		// so type-aware rules can't run there — lint it syntactically instead
		// of not at all, and relax the rules that fight deliberate test idioms
		// (mock factories, any-typed fixtures).
		files: ["src/__tests__/**/*.ts"],
		extends: [tseslint.configs.disableTypeChecked],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-empty-function": "off",
			"no-control-regex": "off",
		},
	},
	{
		ignores: ["dist/", "node_modules/"],
	},
);
