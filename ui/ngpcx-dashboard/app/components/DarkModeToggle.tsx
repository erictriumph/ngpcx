"use client";

import { useEffect, useState } from "react";

export default function DarkModeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    setDark(stored === "dark");
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);

    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      className="p-2 rounded-lg border bg-gray-100 dark:bg-gray-800 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition flex items-center gap-2"
    >
      {dark ? (
        <span className="text-yellow-300">🌙 Dark</span>
      ) : (
        <span className="text-gray-700">☀️ Light</span>
      )}
    </button>
  );
}
