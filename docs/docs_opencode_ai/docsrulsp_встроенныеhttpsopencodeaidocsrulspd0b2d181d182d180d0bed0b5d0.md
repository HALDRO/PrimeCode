<!-- Source: https://opencode.ai/docs/ru/lsp -->

## [Встроенные](https://opencode.ai/docs/ru/lsp#%D0%B2%D1%81%D1%82%D1%80%D0%BE%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5)
opencode поставляется с несколькими встроенными LSP-серверами для популярных языков:
LSP Server | Extensions | Requirements  
---|---|---  
astro | .astro | Автоматически устанавливается для проектов Astro  
bash | .sh, .bash, .zsh, .ksh | Автоматически устанавливает bash-language-server  
clangd | .c, .cpp, .cc, .cxx, .c++, .h, .hpp, .hh, .hxx, .h++ | Автоматически устанавливается для проектов C/C++  
csharp | .cs |  `.NET SDK` установлен  
clojure-lsp | .clj, .cljs, .cljc, .edn |  `clojure-lsp` команда доступна  
dart | .dart |  `dart` команда доступна  
deno | .ts, .tsx, .js, .jsx, .mjs |  `deno` команда доступна (автоматически обнаруживает deno.json/deno.jsonc)  
elixir-ls | .ex, .exs |  `elixir` команда доступна  
eslint | .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts, .vue |  `eslint` зависимость в проекте  
fsharp | .fs, .fsi, .fsx, .fsscript |  `.NET SDK` установлен  
gleam | .gleam |  `gleam` команда доступна  
gopls | .go |  `go` команда доступна  
hls | .hs, .lhs |  `haskell-language-server-wrapper` команда доступна  
jdtls | .java |  `Java SDK (version 21+)` установлен  
kotlin-ls | .kt, .kts | Автоматически устанавливается для проектов Kotlin  
lua-ls | .lua | Автоматически устанавливается для проектов Lua  
nixd | .nix |  `nixd` команда доступна  
ocaml-lsp | .ml, .mli |  `ocamllsp` команда доступна  
oxlint | .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts, .vue, .astro, .svelte |  `oxlint` зависимость в проекте  
php intelephense | .php | Автоматически устанавливается для проектов PHP  
prisma | .prisma |  `prisma` команда доступна  
pyright | .py, .pyi |  `pyright` зависимость установлена  
ruby-lsp (rubocop) | .rb, .rake, .gemspec, .ru |  `ruby` и `gem` команды доступны  
rust | .rs |  `rust-analyzer` команда доступна  
sourcekit-lsp | .swift, .objc, .objcpp |  `swift` установлен (`xcode` на macOS)  
svelte | .svelte | Автоматически устанавливается для проектов Svelte  
terraform | .tf, .tfvars | Автоматически устанавливается из релизов GitHub  
tinymist | .typ, .typc | Автоматически устанавливается из релизов GitHub  
typescript | .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts |  `typescript` зависимость в проекте  
vue | .vue | Автоматически устанавливается для проектов Vue  
yaml-ls | .yaml, .yml | Автоматически устанавливает Red Hat yaml-language-server  
zls | .zig, .zon |  `zig` команда доступна  
Серверы LSP автоматически включаются при обнаружении одного из указанных выше расширений файлов и выполнении требований.
Вы можете отключить автоматическую загрузку LSP-сервера, установив для переменной среды `OPENCODE_DISABLE_LSP_DOWNLOAD` значение `true`.
* * *

