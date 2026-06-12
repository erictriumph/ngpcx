"use client";

import { useEffect, useState } from "react";

export default function ScanProgress({ scanning }: { scanning: boolean }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!scanning) {
      setProgress(0);
      return;
    }

    let current = 0;

    const interval = setInterval(() => {
      current += Math.random() * 8; // smooth-ish
      if (current >= 90) current = 90; // stop before 100
      setProgress(current);
    }, 200);

    return () => clearInterval(interval);
  }, [scanning]);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 animate-fadeIn">
      <div className="bg-white dark:bg-gray-900 p-8 rounded-xl shadow-xl flex flex-col items-center gap-4 w-80">
        <div className="w-full bg-gray-300 dark:bg-gray-700 h-3 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="text-lg font-medium">
          Scanning… {Math.round(progress)}%
        </p>
      </div>
    </div>
  );
}
