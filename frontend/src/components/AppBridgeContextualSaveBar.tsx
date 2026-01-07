import { useCallback, useEffect, useRef } from 'react';
import { waitForAppBridge } from '../lib/app-bridge';

interface SaveAction {
  readonly onAction: () => void | Promise<void>;
  readonly loading?: boolean;
  readonly disabled?: boolean;
}

interface DiscardAction {
  readonly onAction: () => void | Promise<void>;
}

export interface ContextualSaveBarOptions {
  readonly saveAction?: SaveAction;
  readonly discardAction?: DiscardAction;
}

interface AppBridgeContextualSaveBarProps {
  readonly visible: boolean;
  readonly options: ContextualSaveBarOptions;
}

interface ContextualSaveBar {
  readonly show: (options: ContextualSaveBarShowOptions) => void;
  readonly hide: () => void;
}

interface ContextualSaveBarShowOptions {
  readonly saveAction?: {
    readonly onAction: () => Promise<void>;
    readonly loading: boolean;
    readonly disabled: boolean;
  };
  readonly discardAction?: {
    readonly onAction: () => Promise<void>;
  };
}

interface AppBridgeWithContextualSaveBar {
  readonly contextualSaveBar?: ContextualSaveBar;
}

const hasContextualSaveBar = (
  appBridge: unknown,
): appBridge is AppBridgeWithContextualSaveBar => {
  return (
    appBridge !== null &&
    typeof appBridge === 'object' &&
    'contextualSaveBar' in appBridge &&
    appBridge.contextualSaveBar !== null &&
    typeof appBridge.contextualSaveBar === 'object'
  );
};

const hasShowMethod = (contextualSaveBar: unknown): contextualSaveBar is ContextualSaveBar => {
  return (
    contextualSaveBar !== null &&
    typeof contextualSaveBar === 'object' &&
    'show' in contextualSaveBar &&
    typeof contextualSaveBar.show === 'function'
  );
};

const hasHideMethod = (contextualSaveBar: unknown): contextualSaveBar is ContextualSaveBar => {
  return (
    contextualSaveBar !== null &&
    typeof contextualSaveBar === 'object' &&
    'hide' in contextualSaveBar &&
    typeof contextualSaveBar.hide === 'function'
  );
};

export function AppBridgeContextualSaveBar({
  visible,
  options,
}: AppBridgeContextualSaveBarProps): null {
  const isShownRef = useRef(false);
  const isMountedRef = useRef(true);

  const hideContextualSaveBar = useCallback(async (): Promise<void> => {
    if (!isShownRef.current) {
      return;
    }

    try {
      const appBridge = await waitForAppBridge();
      if (!isMountedRef.current) {
        return;
      }

      if (
        hasContextualSaveBar(appBridge) &&
        hasHideMethod(appBridge.contextualSaveBar)
      ) {
        appBridge.contextualSaveBar.hide();
        isShownRef.current = false;
      }
    } catch {
    }
  }, []);

  const showContextualSaveBar = useCallback(async (): Promise<void> => {
    try {
      const appBridge = await waitForAppBridge();
      if (!isMountedRef.current) {
        return;
      }

      if (
        hasContextualSaveBar(appBridge) &&
        hasShowMethod(appBridge.contextualSaveBar)
      ) {
        const showOptions: ContextualSaveBarShowOptions = {
          saveAction: options.saveAction
            ? {
                onAction: async (): Promise<void> => {
                  if (options.saveAction) {
                    await options.saveAction.onAction();
                  }
                },
                loading: options.saveAction.loading ?? false,
                disabled: options.saveAction.disabled ?? false,
              }
            : undefined,
          discardAction: options.discardAction
            ? {
                onAction: async (): Promise<void> => {
                  if (options.discardAction) {
                    await options.discardAction.onAction();
                  }
                },
              }
            : undefined,
        };

        appBridge.contextualSaveBar.show(showOptions);
        isShownRef.current = true;
      }
    } catch {
    }
  }, [options]);

  useEffect(() => {
    isMountedRef.current = true;

    if (!visible) {
      hideContextualSaveBar();
      return;
    }

    showContextualSaveBar();
  }, [visible, options, hideContextualSaveBar, showContextualSaveBar]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (isShownRef.current) {
        waitForAppBridge()
          .then((appBridge) => {
            if (
              hasContextualSaveBar(appBridge) &&
              hasHideMethod(appBridge.contextualSaveBar)
            ) {
              appBridge.contextualSaveBar.hide();
            }
          })
          .catch(() => {
          });
      }
    };
  }, []);

  return null;
}
