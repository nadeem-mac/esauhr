/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'monospace'],
      },
      colors: {
        paper: '#FAF7F0',
        ink: '#0F1F1A',
        evergreen: {
          50: '#F2F6F2',
          100: '#E3EDE5',
          200: '#BFD5C4',
          300: '#8FB39A',
          400: '#5A8A6C',
          500: '#2D5F3F',
          600: '#1F4A2F',
          700: '#173826',
          800: '#0F2818',
          900: '#081810',
        },
        copper: '#C49B61',
        clay: '#B84A3E',
      },
    },
  },
  plugins: [],
};
