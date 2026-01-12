import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactCompiler from "eslint-plugin-react-compiler";
import tailwindCanonicalClasses from "eslint-plugin-tailwind-canonical-classes";

const tailwindCssPath = "./src/webview/global.css";

export default [{
    files: ["**/*.ts", "**/*.tsx"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
        "react-compiler": reactCompiler,
        "tailwind-canonical-classes": tailwindCanonicalClasses,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        // React Compiler rule - identifies violations of Rules of React
        "react-compiler/react-compiler": "error",

        // Tailwind canonicalization (Tailwind v4)
        // Example: bg-[--tool-bg-header] -> bg-(--tool-bg-header)
        "tailwind-canonical-classes/tailwind-canonical-classes": ["warn", {
            cssPath: tailwindCssPath,
        }],
    },
}];
