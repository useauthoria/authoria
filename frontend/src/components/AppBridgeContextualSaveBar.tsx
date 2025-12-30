import { useEffect, useRef } from 'react';
import { waitForAppBridge } from '../lib/app-bridge';

export interface ContextualSaveBarOptions {
  readonly saveAction?: {
    readonly onAction: () => void | Promise<void>;
    readonly loading?: boolean;
    readonly disabled?: boolean;
  };
  readonly discardAction?: {
    readonly onAction: () => void | Promise<void>;
  };
}

interface AppBridgeContextualSaveBarProps {
  readonly visible: boolean;
  readonly options: ContextualSaveBarOptions;
}

/**
 * Contextual Save Bar component using App Bridge
 */
export function AppBridgeContextualSaveBar({ visible, options }: AppBridgeContextualSaveBarProps): null {
  const isShownRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      if (isShownRef.current) {
        waitForAppBridge().then((appBridge) => {
          if (appBridge?.contextualSaveBar?.hide) {
            appBridge.contextualSaveBar.hide();
            isShownRef.current = false;
          }
        });
      }
      return;
    }

    waitForAppBridge().then((appBridge) => {
      if (appBridge?.contextualSaveBar?.show) {
        appBridge.contextualSaveBar.show({
          saveAction: options.saveAction
            ? {
                onAction: async () => {
                  await options.saveAction!.onAction();
                },
                loading: options.saveAction.loading ?? false,
                disabled: options.saveAction.disabled ?? false,
              }
            : undefined,
          discardAction: options.discardAction
            ? {
                onAction: async () => {
                  await options.discardAction!.onAction();
                },
              }
            : undefined,
        });
        isShownRef.current = true;
      }
    });
  }, [visible, options]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isShownRef.current) {
        waitForAppBridge().then((appBridge) => {
          if (appBridge?.contextualSaveBar?.hide) {
            appBridge.contextualSaveBar.hide();
          }
        });
      }
    };
  }, []);

  return null;
}

