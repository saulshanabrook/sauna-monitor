{
  const storageKey = "sauna-time-color-scheme";

  let preference = "system";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {
    // Fall back to the browser preference when storage is unavailable.
  }

  const systemIsDark = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.colorScheme =
    preference === "dark" || (preference === "system" && systemIsDark) ? "dark" : "light";
}
