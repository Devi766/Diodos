import * as React from "react"
import { cn } from "@/lib/utils"

export interface ToastProps {
  message: string;
  type?: 'success' | 'error' | 'info';
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
    info: 'bg-blue-500/90'
  }[type];

  const icon = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
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

interface ToastItem extends ToastProps {
  id: number;
}

const toastListeners: Set<(toasts: ToastItem[]) => void> = new Set();
let toasts: ToastItem[] = [];

const notifyListeners = () => {
  toastListeners.forEach(listener => listener([...toasts]));
};

export const showToast = (props: Omit<ToastProps, 'onClose'>) => {
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

export const ToastContainer: React.FC = () => {
  const [currentToasts, setCurrentToasts] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    toastListeners.add(setCurrentToasts);
    return () => {
      toastListeners.delete(setCurrentToasts);
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

