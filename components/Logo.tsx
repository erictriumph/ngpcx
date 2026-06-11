export function Logo({ dark }: { dark: boolean }) {
  const stroke = dark ? "#f1f5f9" : "#111";
  const fill = dark ? "#f1f5f9" : "#111";

  return (
    <svg width="150" height="36" viewBox="0 0 180 40" fill="none">
      {/* Hollow square badge */}
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="4"
        stroke={stroke}
        strokeWidth="3"
      />

      {/* Wordmark */}
      <text
        x="40"
        y="25"
        fontFamily="Inter, system-ui, sans-serif"
        fontSize="22"
        fontWeight="700"
        fill={fill}
      >
        NGPCX
      </text>
    </svg>
  );
}
