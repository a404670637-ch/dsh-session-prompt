# Changelog

## 0.1.0

- Initial release.
- Per-session pinned prompt stored under `$DSH_HOME/dsh-session-prompt/sessions/`.
- Injected as system-prompt section `session-prompt:pinned` (order 9500), sent in full on every request and immune to context compaction.
- Session-header action + modal editor; read-only while the model is running.
- 5,000-token budget with composition-aware conservative estimator.
- Host tests and GitHub Actions workflow.
