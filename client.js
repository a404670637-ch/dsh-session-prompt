/**
 * dsh-session-prompt — Client half.
 *
 * Adds a compact "Session prompt" action to the session header. The action
 * opens a modal editor for the current conversation only; the Host persists
 * the text and renders it as a system-prompt section on every request.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CHANNEL = '/dsh-session-prompt';
    const NS = 'session-prompt-v1';
    const DEFAULT_MAX_TOKENS = 5000;

    const ZH = {
      action: '提示词',
      actionHint: '为当前对话设置固定提示词（不参与上下文压缩）',
      dialogTitle: '会话提示词',
      dialogSubtitle: '仅对当前对话生效。它作为系统提示词的一部分，随每次请求完整发送，不受上下文压缩影响。',
      runningNotice: '模型正在处理任务，结束后可编辑。',
      placeholder: '在这里写下本对话需要始终遵守的提示词…',
      chars: '字符',
      limitPrefix: '上限',
      limitSuffix: 'tokens（DeepSeek tokenizer 实测 5,000 tokens ≈ 中文 8,800 字 / 英文 28,800 字；为覆盖中英混排与代码，本插件保守限制约中文 7,300 字 / 英文 25,000 字）。',
      lastSaved: '最近保存：',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      clear: '清空',
      close: '关闭',
      saved: '已保存，下一次模型请求生效。',
      errorRunning: '模型正在处理任务，结束后再保存。',
      errorTooLong: '内容超过 token 上限，请删减后再保存。',
      errorUnknownSession: '当前会话不存在或已关闭。',
      errorInternal: '保存失败，请重试。',
      loading: '正在读取…',
    };
    const EN = {
      action: 'Prompt',
      actionHint: 'Pin a prompt for this conversation (never compressed)',
      dialogTitle: 'Session prompt',
      dialogSubtitle: 'Applies to this conversation only. It is part of the system prompt and is sent in full with every request, so context compaction cannot fold it away.',
      runningNotice: 'The model is working. You can edit when it becomes idle.',
      placeholder: 'Write the instructions this conversation should always follow…',
      chars: 'characters',
      limitPrefix: 'Limit',
      limitSuffix: 'tokens (DeepSeek tokenizer: 5,000 tokens ≈ 8,800 Chinese or 28,800 English characters; this plugin enforces a conservative mix/code-safe cap of about 7,300 Chinese or 25,000 English characters).',
      lastSaved: 'Last saved:',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      clear: 'Clear',
      close: 'Close',
      saved: 'Saved. It will apply on the next model request.',
      errorRunning: 'The model is working; save after it becomes idle.',
      errorTooLong: 'The content exceeds the token budget. Shorten it before saving.',
      errorUnknownSession: 'This session no longer exists.',
      errorInternal: 'Save failed. Please retry.',
      loading: 'Loading…',
    };

    function isCjkCodePoint(cp) {
      return (
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x20000 && cp <= 0x2fa1f)
      );
    }

    // Keep this estimator byte-for-byte aligned with index.js.
    function estimateTokens(text) {
      let cjk = 0;
      let ascii = 0;
      let punctuation = 0;
      let other = 0;
      for (const char of String(text)) {
        const cp = char.codePointAt(0);
        if (cp === undefined) continue;
        if (isCjkCodePoint(cp)) cjk += 1;
        else if (cp <= 0x7f) {
          if (
            (cp >= 0x30 && cp <= 0x39) ||
            (cp >= 0x41 && cp <= 0x5a) ||
            (cp >= 0x61 && cp <= 0x7a) ||
            cp === 0x20 ||
            cp === 0x09 ||
            cp === 0x0a ||
            cp === 0x0d
          ) {
            ascii += 1;
          } else {
            punctuation += 1;
          }
        } else if (cp >= 0x1f000) {
          other += 2;
        } else {
          other += 1;
        }
      }
      const total = cjk + ascii + punctuation + other;
      const punctuationRatio = total === 0 ? 0 : punctuation / total;
      const cjkRatio = total === 0 ? 0 : cjk / total;
      let cjkCoefficient;
      let asciiCoefficient;
      let punctuationCoefficient;
      let otherCoefficient;
      if (punctuationRatio > 0.12) {
        cjkCoefficient = 0.66;
        asciiCoefficient = 0.34;
        punctuationCoefficient = 0.82;
        otherCoefficient = 1;
      } else if (cjkRatio > 0.05) {
        cjkCoefficient = 0.66;
        asciiCoefficient = 0.27;
        punctuationCoefficient = 0.75;
        otherCoefficient = 0.95;
      } else {
        cjkCoefficient = 0.62;
        asciiCoefficient = 0.19;
        punctuationCoefficient = 0.5;
        otherCoefficient = 0.9;
      }
      return Math.ceil(cjk * cjkCoefficient + ascii * asciiCoefficient + punctuation * punctuationCoefficient + other * otherCoefficient);
    }

    const CSS = `
      .dsp-action{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;}
      .dsp-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
      .dsp-action-set{color:var(--dsw-alias-label-primary);}
      .dsp-action svg{width:14px;height:14px;flex:none;}
      .dsp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);}
      .dsp-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px;}
      .dsp-panel{width:min(720px,94vw);max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.28);overflow:hidden;}
      .dsp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
      .dsp-title{font-size:15px;font-weight:600;line-height:1.4;}
      .dsp-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.55;}
      .dsp-close{flex:none;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;cursor:pointer;}
      .dsp-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
      .dsp-body{padding:14px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px;}
      .dsp-textarea{width:100%;min-height:300px;resize:vertical;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.6;outline:none;}
      .dsp-textarea:focus{border-color:var(--dsw-alias-brand-primary);}
      .dsp-textarea[readonly]{opacity:.8;}
      .dsp-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);}
      .dsp-count-warn{color:var(--dsw-alias-state-warn-primary);}
      .dsp-count-over{color:var(--dsw-alias-state-error-primary);font-weight:600;}
      .dsp-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;}
      .dsp-bar-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .12s ease;}
      .dsp-bar-warn{background:var(--dsw-alias-state-warn-primary);}
      .dsp-bar-over{background:var(--dsw-alias-state-error-primary);}
      .dsp-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55;}
      .dsp-banner{padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;border:1px solid var(--dsw-alias-border-l1);}
      .dsp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;}
      .dsp-notice{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5;}
      .dsp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px 16px;border-top:1px solid var(--dsw-alias-border-l1);}
      .dsp-foot-right{display:flex;gap:8px;}
      .dsp-btn{height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}
      .dsp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
      .dsp-btn:disabled{opacity:.5;cursor:not-allowed;}
      .dsp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted, #fff);}
      .dsp-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}
    `;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = (() => {
          try {
            const disposeZh = ctx.locale.register(NS, 'zh', ZH);
            const disposeEn = ctx.locale.register(NS, 'en', EN);
            ctx.effect(
              () => () => {
                try { disposeZh(); } catch (_) {}
                try { disposeEn(); } catch (_) {}
              },
              'session-prompt: locale dictionaries',
            );
          } catch (_) {
            // A reloaded module may find its namespace already registered; the
            // existing dictionaries carry the same keys, so binding still works.
          }
          try {
            return ctx.locale.bind(NS);
          } catch (_) {
            return (key) => key;
          }
        })();

        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            try { style.remove(); } catch (_) {}
          };
        }, 'session-prompt: styles');

        const listeners = new Set();
        const prompts = new Map(); // sessionId -> { text, tokens }
        const running = new Map(); // sessionId -> boolean
        let open = false;
        let openSessionId = null;

        const emit = () => {
          for (const listener of [...listeners]) listener();
        };
        const subscribe = (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const setPrompt = (sessionId, value) => {
          prompts.set(sessionId, value);
          emit();
        };
        const setRunning = (sessionId, value) => {
          if (running.get(sessionId) === value) return;
          running.set(sessionId, value);
          emit();
        };
        const openEditor = (sessionId) => {
          open = true;
          openSessionId = sessionId;
          emit();
        };
        const closeEditor = () => {
          open = false;
          openSessionId = null;
          emit();
        };

        async function callRpc(endpoint, payload) {
          try {
            const response = await fetch(`${CHANNEL}/${endpoint}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(payload),
            });
            let body = null;
            try {
              body = await response.json();
            } catch (_) {
              body = null;
            }
            if (!response.ok) {
              return {
                ok: false,
                code: body?.error?.code ?? `HTTP_${response.status}`,
                message: body?.error?.message ?? response.statusText,
                details: body?.error?.details ?? {},
              };
            }
            if (body !== null && typeof body === 'object' && body.ok === true) {
              return { ok: true, data: body.value };
            }
            return {
              ok: false,
              code: body?.error?.code ?? 'INTERNAL',
              message: body?.error?.message ?? '',
              details: body?.error?.details ?? {},
            };
          } catch (error) {
            return { ok: false, code: 'INTERNAL', message: String(error?.message ?? error), details: {} };
          }
        }

        function PinIcon() {
          return h(
            'svg',
            { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', {
              d: 'M9 4.5h6l-.8 5.2 3.3 3.1V15h-4.1l-.9 5h-1l-.9-5H6.5v-2.2l3.3-3.1L9 4.5Z',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinejoin: 'round',
            }),
          );
        }

        function HeaderAction(props) {
          const sessionId = props.sessionId;
          const [, force] = React.useReducer((value) => value + 1, 0);
          const isRunning =
            typeof props.useSessionStatus === 'function'
              ? props.useSessionStatus((snapshot) =>
                  sessionId === undefined ? false : snapshot.get(sessionId)?.running === true,
                )
              : false;

          React.useEffect(() => subscribe(force), []);
          React.useEffect(() => {
            if (sessionId === undefined) return;
            setRunning(sessionId, isRunning === true);
          }, [sessionId, isRunning]);
          React.useEffect(() => {
            if (sessionId === undefined) return;
            let cancelled = false;
            callRpc('get', { sessionId }).then((result) => {
              if (cancelled || !result.ok) return;
              setPrompt(sessionId, { text: result.data.text, tokens: result.data.tokens });
            });
            return () => {
              cancelled = true;
            };
          }, [sessionId]);

          const prompt = sessionId === undefined ? undefined : prompts.get(sessionId);
          const hasPrompt = prompt !== undefined && prompt.text.trim() !== '';
          return h(
            'button',
            {
              type: 'button',
              className: `dsp-action${hasPrompt ? ' dsp-action-set' : ''}`,
              title: hasPrompt ? prompt.text.slice(0, 300) : t('actionHint'),
              'aria-label': t('action'),
              onClick: () => {
                if (sessionId !== undefined) openEditor(sessionId);
              },
            },
            h(PinIcon),
            h('span', null, t('action')),
            hasPrompt ? h('span', { className: 'dsp-dot', 'aria-hidden': true }) : null,
          );
        }

        function Editor() {
          const sessionId = openSessionId;
          const [text, setText] = React.useState('');
          const [loading, setLoading] = React.useState(true);
          const [saving, setSaving] = React.useState(false);
          const [error, setError] = React.useState('');
          const [notice, setNotice] = React.useState('');
          const [remoteRunning, setRemoteRunning] = React.useState(false);
          const [updatedAt, setUpdatedAt] = React.useState(0);
          const [maxTokens, setMaxTokens] = React.useState(DEFAULT_MAX_TOKENS);

          React.useEffect(() => {
            if (sessionId === null) return;
            let cancelled = false;
            setLoading(true);
            callRpc('get', { sessionId }).then((result) => {
              if (cancelled) return;
              setLoading(false);
              if (result.ok) {
                setText(result.data.text);
                setRemoteRunning(result.data.running === true);
                setUpdatedAt(result.data.updatedAt);
                if (Number.isFinite(result.data.maxTokens)) setMaxTokens(result.data.maxTokens);
                setPrompt(sessionId, { text: result.data.text, tokens: result.data.tokens });
              } else {
                setError(result.code === 'UNKNOWN_SESSION' ? t('errorUnknownSession') : t('errorInternal'));
              }
            });
            return () => {
              cancelled = true;
            };
          }, [sessionId]);

          React.useEffect(() => {
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeEditor();
              }
            };
            document.addEventListener('keydown', onKeyDown);
            return () => document.removeEventListener('keydown', onKeyDown);
          }, []);

          const runningNow = running.get(sessionId) === true || remoteRunning;
          const disabled = loading || saving || runningNow;
          const tokens = estimateTokens(text);
          const chars = [...text].length;
          const over = tokens > maxTokens;
          const near = !over && tokens >= Math.floor(maxTokens * 0.9);
          const countClass = over ? 'dsp-count-over' : near ? 'dsp-count-warn' : '';

          async function save() {
            if (disabled) return;
            if (tokens > maxTokens) {
              setError(t('errorTooLong'));
              return;
            }
            setSaving(true);
            setError('');
            setNotice('');
            const result = await callRpc('save', { sessionId, text });
            setSaving(false);
            if (!result.ok) {
              if (result.code === 'RUNNING') {
                setRemoteRunning(true);
                setError(t('errorRunning'));
              } else if (result.code === 'TOO_LONG') {
                setError(t('errorTooLong'));
              } else if (result.code === 'UNKNOWN_SESSION') {
                setError(t('errorUnknownSession'));
              } else {
                setError(t('errorInternal'));
              }
              return;
            }
            setRemoteRunning(result.data.running === true);
            setUpdatedAt(result.data.updatedAt);
            setPrompt(sessionId, { text: result.data.text, tokens: result.data.tokens });
            setNotice(t('saved'));
          }

          return h(
            'div',
            {
              className: 'dsp-backdrop',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) closeEditor();
              },
            },
            h(
              'div',
              {
                className: 'dsp-panel',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('dialogTitle'),
              },
              h(
                'div',
                { className: 'dsp-head' },
                h(
                  'div',
                  null,
                  h('div', { className: 'dsp-title' }, t('dialogTitle')),
                  h('div', { className: 'dsp-sub' }, t('dialogSubtitle')),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsp-close', onClick: closeEditor, 'aria-label': t('close') },
                  '✕',
                ),
              ),
              h(
                'div',
                { className: 'dsp-body' },
                runningNow ? h('div', { className: 'dsp-banner' }, t('runningNotice')) : null,
                loading
                  ? h('div', { className: 'dsp-hint' }, t('loading'))
                  : h('textarea', {
                      className: 'dsp-textarea',
                      value: text,
                      readOnly: disabled,
                      autoFocus: true,
                      spellCheck: false,
                      placeholder: t('placeholder'),
                      onChange: (event) => {
                        setText(event.target.value);
                        setError('');
                        setNotice('');
                      },
                      onKeyDown: (event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void save();
                        }
                      },
                    }),
                h(
                  'div',
                  { className: 'dsp-meta' },
                  h('span', { className: countClass }, `${tokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`),
                  h('span', null, `${chars.toLocaleString()} ${t('chars')}`),
                ),
                h(
                  'div',
                  { className: 'dsp-bar' },
                  h('div', {
                    className: `dsp-bar-fill${over ? ' dsp-bar-over' : near ? ' dsp-bar-warn' : ''}`,
                    style: { width: `${Math.min(100, (tokens / maxTokens) * 100)}%` },
                  }),
                ),
                h(
                  'div',
                  { className: 'dsp-hint' },
                  `${t('limitPrefix')} ${maxTokens.toLocaleString()} ${t('limitSuffix')}`,
                ),
                error !== '' ? h('div', { className: 'dsp-error' }, error) : null,
                notice !== '' ? h('div', { className: 'dsp-notice' }, notice) : null,
                updatedAt > 0
                  ? h(
                      'div',
                      { className: 'dsp-hint' },
                      `${t('lastSaved')} ${new Date(updatedAt).toLocaleString()}`,
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'dsp-foot' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsp-btn dsp-btn-ghost',
                    disabled: disabled,
                    onClick: () => {
                      setText('');
                      setError('');
                      setNotice('');
                    },
                  },
                  t('clear'),
                ),
                h(
                  'div',
                  { className: 'dsp-foot-right' },
                  h(
                    'button',
                    { type: 'button', className: 'dsp-btn', onClick: closeEditor },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsp-btn dsp-btn-primary',
                      disabled: disabled || over,
                      onClick: () => void save(),
                    },
                    saving ? t('saving') : t('save'),
                  ),
                ),
              ),
            ),
          );
        }

        function Dialog() {
          const [, force] = React.useReducer((value) => value + 1, 0);
          React.useEffect(() => subscribe(force), []);
          if (!open || openSessionId === null) return null;
          return h(Editor, { key: openSessionId });
        }

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'session-prompt',
              order: 20,
              label: t('action'),
            },
            HeaderAction,
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-prompt',
              order: 180,
            },
            Dialog,
          ),
        );
      },
    };
  },
});
