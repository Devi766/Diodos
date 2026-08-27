'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';

interface PageTransitionProps {
  children: React.ReactNode;
  fullHeight?: boolean;
}

const pageTransition = {
  duration: 0.2,
  ease: [0.22, 1, 0.36, 1] as const,
};

/**
 * Keeps the previous route painted while Next mounts the next client chunk.
 * Opacity-only animation avoids creating a containing block for fixed dialogs.
 */
export default function PageTransition({ children, fullHeight = false }: PageTransitionProps) {
  const pathname = usePathname() || '/';

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={pathname}
          className={fullHeight ? 'h-full min-h-0 w-full' : 'w-full'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={pageTransition}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  );
}
