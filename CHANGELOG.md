# Changelog

## [0.3.2](https://github.com/Luminger/pi-python/compare/v0.3.1...v0.3.2) (2026-09-20)


### Features

* honor pi agent config directories for settings ([#4](https://github.com/Luminger/pi-python/issues/4)) ([eaad718](https://github.com/Luminger/pi-python/commit/eaad71827765f0875692cd00fe1fbac6f8678fe6))
* make persistent Python the default agent path ([#3](https://github.com/Luminger/pi-python/issues/3)) ([b47e2b0](https://github.com/Luminger/pi-python/commit/b47e2b02ad9d55cf2b38f600410bf49a1db8c157))

## [0.3.1](https://github.com/Luminger/pi-python/compare/v0.3.0...v0.3.1) (2026-09-17)


### Chores

* cut 0.3.1 to exercise the fixed publish path ([5a3cea6](https://github.com/Luminger/pi-python/commit/5a3cea6a35ed526643798f9ce9a10d63aa9d2cfd))

## [0.3.0](https://github.com/Luminger/pi-python/compare/v0.2.0...v0.3.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* the namespace no longer survives /python-restart, python_set_interpreter, a hard kill, or a pi restart. Write state to a file from inside a cell if it needs to outlive the kernel process.

### Features

* configurable timeout ceiling, interrupt grace, and live cell timer ([26248d1](https://github.com/Luminger/pi-python/commit/26248d1ff0e811d07c084ff3f0e45d821c945432))
* **resolver:** venv parent-walk + configurable venvDirNames ([48fbd0e](https://github.com/Luminger/pi-python/commit/48fbd0ecbc714b97297b4deec704430eb656fd38))


### Bug Fixes

* do not inherit a PYTHONPATH built for another interpreter ([d7ef9ef](https://github.com/Luminger/pi-python/commit/d7ef9ef625cf3ac56a018782128d06bc78fc9c8e))
* survive uninterruptible cells and stale kernel process events ([3f793b1](https://github.com/Luminger/pi-python/commit/3f793b1a1347c43d6bebe4f664d9843b3c2ab59a))
* target [@earendil-works](https://github.com/earendil-works) scope for pi core packages ([9004962](https://github.com/Luminger/pi-python/commit/90049622201e299a117944cd32ac02e273ef99c5))


### Refactoring

* remove on-disk namespace checkpointing ([13894a9](https://github.com/Luminger/pi-python/commit/13894a91045aacbc5abcaa2f1e32489d0b68de73))


### Documentation

* add a security policy ([ccb60d3](https://github.com/Luminger/pi-python/commit/ccb60d3b0937e107c407a3d3f69e17ab1c1d102b))
* correct stale claims and state the threat model ([e537a89](https://github.com/Luminger/pi-python/commit/e537a8976d299236c97c2446f954dd0058d85bec))
* document branch protection and the release PR check gap ([b06fb6d](https://github.com/Luminger/pi-python/commit/b06fb6d3ee9181fb1537fc6753bcfe8809521642))
* document install, release flow, and what breaking actually means ([7f811a6](https://github.com/Luminger/pi-python/commit/7f811a663480fe95b073b2aae35fdfd9d834d3d1))
