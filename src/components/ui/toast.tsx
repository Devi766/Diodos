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

  const bgColor = {
    success: 'bg-green-500/90',
    error: 'bg-red-500/90',
    info: 'bg-blue-500/90',
    warning: 'bg-amber-500/90'
  }[type];

  const icon = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '!'
  }[type];

  return (
    <div className={cn(
      "fixed top-4 right-4 z-50 flex items-start gap-3 px-6 py-4 rounded-xl shadow-lg backdrop-blur-md text-white animate-in slide-in-from-top-5 max-w-md",
      bgColor
    )}>
      <span className="text-xl font-bold flex-shrink-0">{icon}</span>
      <span className="text-sm font-medium break-words flex-1 min-w-0">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="ml-2 text-white/80 hover:text-white transition-colors flex-shrink-0"
        >
          ✕
        </button>
      )}
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
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      pointerEvents: 'none',
      maxWidth: 'min(420px, calc(100vw - 32px))'
    });
    document.body.appendChild(root);
  }

  return root;
};

const renderDomToast = ({ message, type = 'info', duration = 3000 }: ToastEventPayload) => {
  const root = getDomToastRoot();
  if (!root) return;

  const color = {
    success: '#16a34a',
    error: '#dc2626',
    info: '#2563eb',
    warning: '#d97706'
  }[type];

  const toast = document.createElement('div');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  Object.assign(toast.style, {
    boxSizing: 'border-box',
    width: '100%',
    padding: '12px 16px',
    borderRadius: '12px',
    background: color,
    color: '#fff',
    boxShadow: '0 18px 45px rgba(15, 23, 42, 0.22)',
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    opacity: '1',
    transform: 'translateY(0)',
    transition: 'opacity 160ms ease, transform 160ms ease',
    pointerEvents: 'auto'
  });

  root.appendChild(toast);

  const remove = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
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
    <>
      {currentToasts.map((toast, index) => (
        <div key={toast.id} style={{ top: `${16 + index * 80}px` }} className="fixed right-4 z-50">
          <Toast {...toast} />
        </div>
      ))}
    </>
  );
};

export { Toast };

