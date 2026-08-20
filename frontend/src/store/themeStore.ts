import { create } from 'zustand';

type ThemeMode = 'light' | 'dark';

interface ThemeState {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (theme: ThemeMode) => void;
}

const applyThemeToDocument = (theme: ThemeMode) => {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
};

export const useTheme = create<ThemeState>((set) => {
  // Initialize theme from localStorage or system preference
  const savedTheme = localStorage.getItem('theme') as ThemeMode | null;
  const initialTheme = savedTheme 
    ? savedTheme 
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  
  // Apply immediately on load
  applyThemeToDocument(initialTheme);

  return {
    theme: initialTheme,
    toggleTheme: () => set((state) => {
      const newTheme = state.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', newTheme);
      applyThemeToDocument(newTheme);
      return { theme: newTheme };
    }),
    setTheme: (theme) => set(() => {
      localStorage.setItem('theme', theme);
      applyThemeToDocument(theme);
      return { theme };
    }),
  };
});
