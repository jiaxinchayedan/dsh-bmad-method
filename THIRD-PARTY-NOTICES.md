# Third-party notices

This package redistributes content that is not ours. Scope and provenance are
listed below so nobody has to guess what is under which license.

## BMad Method — BMAD-METHOD

- **Upstream:** https://github.com/bmad-code-org/BMAD-METHOD
- **Version:** 6.12.4 (npm package `bmad-method`)
- **Copyright:** BMad Code, LLC
- **License:** MIT (https://github.com/bmad-code-org/BMAD-METHOD/blob/main/LICENSE)
- **What we redistribute:**
  - `skills/` — 90 skills (SKILL.md, customize.toml, assets/, references/, scripts)
  - `bmad-home/_bmad/` — the runtime template: config.toml, per-module
    config.yaml, `_bmad/scripts/*.py`, `_bmad/_config/*`
- **What we changed:**
  - Generated `skills/manifest.json` (skill → module map) from upstream
    `_config/skill-manifest.csv`; upstream ships no such file.
  - `bmad-home/_bmad/config.toml` and per-module `config.yaml`: default values
    only (user name, language, output folder) plus the artifact-path and
    duplicate-key normalizations described in README. No prompt or workflow
    text was edited.
  - `skills/*/SKILL.md` bodies are redistributed **verbatim**; placeholders
    (`{project-root}`, `{skill-root}`, `{skill-name}`) are substituted at load
    time by our skill provider, not by editing files on disk.
- **Trademark:** "BMad" and "BMAD-METHOD" are trademarks of BMad Code, LLC.
  This package is an unofficial community port and is not affiliated with,
  endorsed by, or sponsored by BMad Code, LLC.

## BMad official modules

The 90 skills also include content from the official BMad modules, all MIT:

| Module | Code | Upstream | Version |
| --- | --- | --- | --- |
| BMad Builder | `bmb` | https://github.com/bmad-code-org/bmad-builder | v2.2.2 |
| BMad Test Architect | `tea` | https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise | v1.27.2 |
| BMad Creative Intelligence Suite | `cis` | https://github.com/bmad-code-org/bmad-module-creative-intelligence-suite | v0.3.2 |
| BMad Game Dev Studio | `gds` | https://github.com/bmad-code-org/bmad-module-game-dev-studio | v0.7.2 |
| BMad Loop | `bmad-loop` | https://github.com/bmad-code-org/bmad-loop | v0.13.2 |

Copyright of each belongs to its respective authors under the MIT license.

## Runtime dependencies

- `bmad-method` (MIT, BMad Code, LLC) — the official installer, invoked by the
  `bmad_project_install` tool. Not modified.
- `yaml` (ISC, Eemeli Aro) — frontmatter and config parsing.
- `@deepseek-ai/schemastery` — declared as a **peer** dependency; the dsh host
  provides it. Not redistributed here.

## This package

Everything else — `index.js`, `client.js`, `lib/`, `locale/`, `icon.svg`,
`test/` — is original work released under the MIT license in `LICENSE`.
