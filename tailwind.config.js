/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "#3370ff",
        "primary-light": "#e1eaff",
        "primary-hover": "#285bd4",
        "background-light": "#f5f6f7",
        "background-dark": "#131022",
        "surface-light": "#ffffff",
        "surface-dark": "#1c1833",
        "border-light": "#dee0e3",
        "border-dark": "#2d2a45",
        "text-main": "#1f2329",
        "text-secondary": "#646a73",
      },
      fontFamily: {
        "display": ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"]
      },
      borderRadius: {
        "DEFAULT": "0.375rem",
        "lg": "0.5rem",
        "xl": "0.75rem",
        "2xl": "1rem",
        "full": "9999px"
      },
      boxShadow: {
        "lark": "0 2px 8px 0 rgba(0,0,0,0.04), 0 1px 2px 0 rgba(0,0,0,0.02)"
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries')
  ],
}

