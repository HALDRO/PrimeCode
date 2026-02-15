<!-- Source: https://opencode.ai/docs/formatters -->

## [Встроенные](https://opencode.ai/docs/formatters#%D0%B2%D1%81%D1%82%D1%80%D0%BE%D0%B5%D0%BD%D0%BD%D1%8B%D0%B5)
opencode поставляется с несколькими встроенными форматировщиками для популярных языков и платформ. Ниже приведен список форматтеров, поддерживаемых расширений файлов, а также необходимых команд или параметров конфигурации.
Formatter | Расширения | Требования  
---|---|---  
gofmt | .go | Доступна команда `gofmt`  
mix | .ex, .exs, .eex, .heex, .leex, .neex, .sface | Доступна команда `mix`  
prettier | .js, .jsx, .ts, .tsx, .html, .css, .md, .json, .yaml и [подробнее](https://prettier.io/docs/en/index.html) | Зависимость `prettier` в `package.json`  
biome | .js, .jsx, .ts, .tsx, .html, .css, .md, .json, .yaml и [подробнее](https://biomejs.dev/) | Конфигурационный файл `biome.json(c)`  
zig | .zig, .zon | Доступна команда `zig`  
clang-format | .c, .cpp, .h, .hpp, .ino и [подробнее](https://clang.llvm.org/docs/ClangFormat.html) | Конфигурационный файл `.clang-format`  
ktlint | .kt, .kts | Доступна команда `ktlint`  
ruff | .py, .pyi | Команда `ruff` доступна в конфигурации  
rustfmt | .rs | Доступна команда `rustfmt`  
cargofmt | .rs | Доступна команда `cargo fmt`  
uv | .py, .pyi | Доступна команда `uv`  
rubocop | .rb, .rake, .gemspec, .ru | Доступна команда `rubocop`  
standardrb | .rb, .rake, .gemspec, .ru | Доступна команда `standardrb`  
htmlbeautifier | .erb, .html.erb | Доступна команда `htmlbeautifier`  
air | .R | Доступна команда `air`  
dart | .dart | Доступна команда `dart`  
ocamlformat | .ml, .mli | Доступна команда `ocamlformat` и файл конфигурации `.ocamlformat`.  
terraform | .tf, .tfvars | Доступна команда `terraform`  
gleam | .gleam | Доступна команда `gleam`  
nixfmt | .nix | Доступна команда `nixfmt`  
shfmt | .sh, .bash | Доступна команда `shfmt`  
pint | .php | Зависимость `laravel/pint` в `composer.json`  
oxfmt (Experimental) | .js, .jsx, .ts, .tsx | Зависимость `oxfmt` в `package.json` и [экспериментальный флаг переменной окружения](https://opencode.ai/docs/cli/#experimental)  
ormolu | .hs | Доступна команда `ormolu`  
Поэтому, если ваш проект имеет `prettier` в вашем `package.json`, opencode автоматически будет использовать его.
* * *

