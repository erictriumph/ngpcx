"use client";

import { useEffect } from "react";

export default function Toast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      className="
        fixed bottom-6 right-6
        bg-white/80 dark:bg-gray-900/80
        backdrop-blur-xl
        border border-gray-300 dark:border-gray-700
        shadow-xl rounded-xl px-5 py-3
        text-gray-900 dark:text-gray-100
        animate-fadeIn
      "
    >
      {message}
    </div>
  );
}
