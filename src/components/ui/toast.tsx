import * as React from "react"
import { cn } from "@/lib/utils"

export interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info' | 'warning';
  duration?: number;
  onClose?: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, type = 'info', duration = 3000, onClose }) => {
  React.useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onClose?.();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const tone = {
    success: {
      title: '成功',
      icon: '✓',
      className: 'bg-green-500/10 text-green-600 dark:text-green-400',
    },
    error: {
      title: '错误',
      icon: '✕',
      className: 'bg-red-500/10 text-red-600 dark:text-red-400',
    },
    info: {
      title: '提示',
      icon: 'ℹ',
      className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    },
    warning: {
      title: '警告',
      icon: '!',
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
  }[type];

  const separatorMatch = message.match(/^([^:：]{1,16})[:：]\s*([\s\S]+)$/);
  const title = separatorMatch?.[1]?.trim() || tone.title;
  const description = separatorMatch?.[2]?.trim() || message;

  return (
    <div className={cn(
      "w-full rounded-2xl bg-white/95 p-4 shadow-[0_18px_45px_-28px_rgba(15,23,42,0.32),0_8px_22px_-18px_rgba(15,23,42,0.2)] backdrop-blur-sm animate-in slide-in-from-bottom-2 dark:bg-[#2a2a2a]/95"
    )}>
      <div className="flex items-start gap-3">
        <span className={cn("flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold", tone.className)}>
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {description}
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="flex-shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
};

// Toast 容器和管理器
let toastId = 0;
const TOAST_EVENT = 'flyclash:toast';

interface ToastItem extends ToastProps {
  id: number;
}

type ToastEventPayload = Omit<ToastProps, 'onClose'>;
type ToastWindow = Window & {
  __flyclashToastQueue?: ToastEventPayload[];
};

const toastListeners: Set<(toasts: ToastItem[]) => void> = new Set();
let toasts: ToastItem[] = [];
let isToastContainerMounted = false;

const notifyListeners = () => {
  toastListeners.forEach(listener => listener([...toasts]));
};

const createToast = (props: ToastEventPayload) => {
  const id = toastId++;
  const toast: ToastItem = {
    ...props,
    id,
    onClose: () => {
      toasts = toasts.filter(t => t.id !== id);
      notifyListeners();
    }
  };
  toasts.push(toast);
  notifyListeners();
};

const getGlobalToastQueue = () => {
  if (typeof window === 'undefined') return null;
  const toastWindow = window as ToastWindow;
  if (!toastWindow.__flyclashToastQueue) {
    toastWindow.__flyclashToastQueue = [];
  }
  return toastWindow.__flyclashToastQueue;
};

const getDomToastRoot = () => {
  if (typeof document === 'undefined') return null;

  let root = document.getElementById('flyclash-toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'flyclash-toast-root';
    root.setAttribute('aria-live', 'polite');
    Object.assign(root.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      pointerEvents: 'none',
      width: 'min(320px, calc(100vw - 48px))',
    });
    document.body.appendChild(root);
  }

  return root;
};

const renderDomToast = ({ message, type = 'info', duration = 3000 }: ToastEventPayload) => {
  const root = getDomToastRoot();
  if (!root) return;

  const tone = {
    success: { title: '成功', icon: '✓', color: '#16a34a', background: 'rgba(34, 197, 94, 0.10)' },
    error: { title: '错误', icon: '✕', color: '#dc2626', background: 'rgba(239, 68, 68, 0.10)' },
    info: { title: '提示', icon: 'ℹ', color: '#2563eb', background: 'rgba(59, 130, 246, 0.10)' },
    warning: { title: '警告', icon: '!', color: '#d97706', background: 'rgba(245, 158, 11, 0.10)' },
  }[type];
  const separatorMatch = message.match(/^([^:：]{1,16})[:：]\s*([\s\S]+)$/);
  const title = separatorMatch?.[1]?.trim() || tone.title;
  const description = separatorMatch?.[2]?.trim() || message;

  const toast = document.createElement('div');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  Object.assign(toast.style, {
    boxSizing: 'border-box',
    width: '100%',
    padding: '16px',
    borderRadius: '16px',
    background: 'rgba(255, 255, 255, 0.96)',
    color: '#0f172a',
    border: '0',
    boxShadow: '0 18px 45px -28px rgba(15, 23, 42, 0.32), 0 8px 22px -18px rgba(15, 23, 42, 0.2)',
    fontSize: '13px',
    fontWeight: '400',
    lineHeight: '1.45',
    maxHeight: '160px',
    opacity: '1',
    transform: 'translateY(0)',
    transition: 'opacity 160ms ease, transform 160ms ease',
    pointerEvents: 'auto'
  });
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
  });

  const icon = document.createElement('span');
  icon.textContent = tone.icon;
  Object.assign(icon.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: '20px',
    height: '20px',
    borderRadius: '999px',
    background: tone.background,
    color: tone.color,
    fontSize: '12px',
    fontWeight: '700',
  });

  const content = document.createElement('div');
  Object.assign(content.style, {
    minWidth: '0',
    flex: '1',
  });

  const titleElement = document.createElement('div');
  titleElement.textContent = title;
  Object.assign(titleElement.style, {
    fontSize: '14px',
    fontWeight: '700',
    color: '#0f172a',
  });

  const descriptionElement = document.createElement('div');
  descriptionElement.textContent = description;
  Object.assign(descriptionElement.style, {
    marginTop: '4px',
    color: '#64748b',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  });

  content.appendChild(titleElement);
  content.appendChild(descriptionElement);
  row.appendChild(icon);
  row.appendChild(content);
  toast.appendChild(row);

  root.appendChild(toast);

  const remove = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    window.setTimeout(() => {
      toast.remove();
      if (!root.hasChildNodes()) {
        root.remove();
      }
    }, 180);
  };

  if (duration > 0) {
    window.setTimeout(remove, duration);
  }
};

export const showToast = (props: ToastEventPayload) => {
  if (typeof window === 'undefined') {
    createToast(props);
    return;
  }

  if (isToastContainerMounted) {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: props }));
    return;
  }

  renderDomToast(props);
};

export const ToastContainer: React.FC = () => {
  const [currentToasts, setCurrentToasts] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    const handleToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastEventPayload>).detail;
      if (!detail) return;
      createToast(detail);

      const queue = getGlobalToastQueue();
      const index = queue ? queue.indexOf(detail) : -1;
      if (queue && index >= 0) {
        queue.splice(index, 1);
      }
    };

    isToastContainerMounted = true;
    toastListeners.add(setCurrentToasts);
    window.addEventListener(TOAST_EVENT, handleToast);

    const queue = getGlobalToastQueue();
    if (queue && queue.length > 0) {
      queue.splice(0).forEach(createToast);
    }

    return () => {
      isToastContainerMounted = false;
      toastListeners.delete(setCurrentToasts);
      window.removeEventListener(TOAST_EVENT, handleToast);
    };
  }, []);

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-3">
      {currentToasts.map((toast) => (
        <div key={toast.id}>
          <Toast {...toast} />
        </div>
      ))}
    </div>
  );
};

export { Toast };

