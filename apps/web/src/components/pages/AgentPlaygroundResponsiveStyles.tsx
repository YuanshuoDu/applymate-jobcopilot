export function AgentPlaygroundResponsiveStyles() {
  return (
    <style>{`
        @media (max-width: 900px) {
          .agent-workspace-layout {
            position: relative;
            min-height: 0 !important;
            overflow: hidden !important;
            flex-direction: column !important;
          }

          .agent-session-drawer-trigger {
            display: inline-flex !important;
            align-items: center;
            gap: 6px;
            min-height: 34px;
            padding: 0 10px;
            border: 1px solid var(--border);
            border-radius: 9px;
            color: var(--text);
            background: var(--bg);
            font: inherit;
            font-size: 11px;
            font-weight: 650;
            cursor: pointer;
          }

          .agent-session-drawer-scrim {
            position: absolute;
            inset: 0;
            z-index: 29;
            border: 0;
            background: rgba(15, 23, 42, 0.34);
            opacity: 0;
            pointer-events: none;
            transition: opacity 180ms ease;
          }

          .agent-session-drawer-scrim.is-open {
            opacity: 1;
            pointer-events: auto;
          }

          .agent-session-drawer {
            position: absolute;
            inset: 0 auto 0 0;
            z-index: 30;
            width: min(calc(100vw - 44px), 360px);
            display: flex;
            flex-direction: column;
            transform: translateX(-104%);
            pointer-events: none;
            transition: transform 180ms ease;
          }

          .agent-session-drawer.is-open {
            transform: translateX(0);
            pointer-events: auto;
          }

          .agent-session-drawer > .agent-session-console {
            flex: 1;
            min-height: 0;
            width: 100% !important;
            height: auto !important;
            border-right: 1px solid var(--border) !important;
            box-shadow: 14px 0 32px rgba(15, 23, 42, 0.18);
          }

          .agent-session-drawer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 48px;
            padding: 8px 10px 8px 14px;
            border-bottom: 1px solid var(--border);
            color: var(--text);
            background: var(--bg);
            font-size: 13px;
            font-weight: 750;
          }

          .agent-session-drawer-actions {
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }

          .agent-session-drawer-collapse {
            display: inline-grid;
            width: 34px;
            height: 34px;
            place-items: center;
            border: 1px solid var(--border);
            border-radius: 10px;
            color: var(--text-muted);
            background: var(--bg);
            cursor: pointer;
          }

          .agent-session-drawer-home {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: 34px;
            padding: 0 10px;
            border: 0;
            border-radius: 10px;
            color: var(--primary);
            background: rgba(79, 70, 229, 0.08);
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 750;
          }

          .agent-live-stream {
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            overflow: hidden !important;
          }

          .agent-live-stream-body {
            min-height: 0 !important;
            overflow-y: auto !important;
            overscroll-behavior-y: contain !important;
            -webkit-overflow-scrolling: touch;
          }

          .agent-composer,
          .agent-composer-add-menu,
          .agent-composer-model-dialog {
            min-width: 0 !important;
            max-width: calc(100vw - 32px) !important;
          }

          .agent-new-chat-starters {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }

        @media (min-width: 901px) {
          .agent-session-drawer-scrim,
          .agent-session-drawer-header,
          .agent-session-drawer-home,
          .agent-session-drawer-collapse,
          .agent-session-drawer-trigger {
            display: none;
          }

          .agent-session-drawer {
            display: contents;
          }
        }
      `}</style>
  )
}
