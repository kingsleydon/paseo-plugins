# Changelog

## [0.2.4](https://github.com/kingsleydon/paseo-plugins/compare/v0.2.3...recap-v0.2.4) (2026-10-20)

### Bug Fixes

* Support the opencode 2.x CLI, which removed `run --pure` and `--dir` ([#19](https://github.com/kingsleydon/paseo-plugins/pull/19))

### Miscellaneous Chores

* Move to `plugins/recap` in the paseo-plugins monorepo; tags are now `recap-v<version>` ([#15](https://github.com/kingsleydon/paseo-plugins/pull/15))

## [0.2.3](https://github.com/kingsleydon/paseo-plugins/compare/v0.2.2...v0.2.3) (2026-10-12)

### Bug Fixes

* Load on iOS and Android: no class syntax in client code ([#14](https://github.com/kingsleydon/paseo-plugins/pull/14))

## [0.2.2](https://github.com/kingsleydon/paseo-plugins/compare/v0.2.1...v0.2.2) (2026-10-12)

### Documentation

* The overview says that short error messages from recent turns reach the recap model ([#13](https://github.com/kingsleydon/paseo-plugins/pull/13))

## [0.2.1](https://github.com/kingsleydon/paseo-plugins/compare/v0.2.0...v0.2.1) (2026-10-12)

### Miscellaneous Chores

* Clean up code and add listing metadata (description, author) ([#12](https://github.com/kingsleydon/paseo-plugins/pull/12))

## [0.2.0](https://github.com/kingsleydon/paseo-plugins/releases/tag/v0.2.0) (2026-10-12)

### Features

* Pick recap models the way Paseo's metadata generation does ([#9](https://github.com/kingsleydon/paseo-plugins/pull/9))

### Miscellaneous Chores

* Publish to npm with trusted publishing (OIDC) ([#8](https://github.com/kingsleydon/paseo-plugins/pull/8), [#10](https://github.com/kingsleydon/paseo-plugins/pull/10))

## 0.1.0 (2026-10-12)

### Features

* Recaps that behave and look like Claude Code's: conversation line, pill, card, and typed settings ([#1](https://github.com/kingsleydon/paseo-plugins/pull/1))
* Store overview; the command is now `/paseo-recap` ([#3](https://github.com/kingsleydon/paseo-plugins/pull/3))
* First npm release ([#7](https://github.com/kingsleydon/paseo-plugins/pull/7))

### Bug Fixes

* Install from GitHub: import Paseo types from the plugin SDK ([#2](https://github.com/kingsleydon/paseo-plugins/pull/2))
* Clipped recap card and a quieter Regenerate ([#4](https://github.com/kingsleydon/paseo-plugins/pull/4))
* Clipped spinner in the Recap pill ([#6](https://github.com/kingsleydon/paseo-plugins/pull/6))

### Documentation

* The overview explains model fallback and OpenCode session cleanup ([#5](https://github.com/kingsleydon/paseo-plugins/pull/5))
