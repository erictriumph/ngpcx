"use client";

import DarkModeToggle from "./DarkModeToggle";

export default function Sidebar() {
  return (
    <aside
      className="
        fixed left-0 top-0 h-full w-[280px]
        border-r border-gray-200 dark:border-gray-800
        bg-white/70 dark:bg-gray-900/70
        backdrop-blur-xl
        flex flex-col
        shadow-sm
      "
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-200 dark:border-gray-800">
        <div
          className="
            w-10 h-10 rounded-xl
            bg-white/30 dark:bg-white/10
            backdrop-blur-md
            flex items-center justify-center
            text-blue-600 dark:text-blue-400
            font-bold text-xl
            shadow
          "
        >
          N
        </div>
        <span className="text-xl font-semibold tracking-tight">NGPCX</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-6 space-y-1">
        <SidebarItem label="Dashboard" active />
        <SidebarItem label="Scan History" />
        <SidebarItem label="Settings" />
        <SidebarItem label="About" />
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800">
        <DarkModeToggle />
      </div>
    </aside>
  );
}

function SidebarItem({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <div
      className={`
        px-4 py-2 rounded-lg cursor-pointer
        transition-all
        ${active
          ? "bg-blue-600 text-white shadow-sm"
          : "hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
        }
      `}
    >
      {label}
    </div>
  );
}
