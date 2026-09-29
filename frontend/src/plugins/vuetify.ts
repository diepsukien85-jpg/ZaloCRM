import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';

/**
 * Vuetify theme — palette từ design tokens Smax (mockup chat-smax-v3.html).
 * `smax-light` (default) khớp mockup. `legacy-dark` giữ lại để fallback nếu
 * có view nào còn phụ thuộc bảng màu cũ; sẽ rút khi mọi view đã migrate.
 *
 * Perf 2026-06-19: KHÔNG đăng ký `* as components/directives` toàn cục nữa —
 * vite-plugin-vuetify({ autoImport: true }) (vite.config.ts) chỉ bundle component
 * thực sự dùng trong template. Import wildcard trước đây kéo TOÀN BỘ Vuetify vào
 * entry chunk, vô hiệu hoá tree-shaking → bundle phình + chậm first paint.
 */
export const vuetify = createVuetify({
  theme: {
    // 29/09/2026: chỉ dùng giao diện sáng (đồng bộ App nội bộ — không có giao diện tối; theme tối cũ
    // chưa hoàn thiện, nhiều trang chữ trắng trên nền sáng).
    defaultTheme: 'smax-light',
    themes: {
      // Tên 'smax-light' giữ nguyên (localStorage cũ) — màu theo App nội bộ (bot-noi-bo, 29/09/2026).
      'smax-light': {
        dark: false,
        colors: {
          background: '#F0F7FF',
          surface: '#ffffff',
          'surface-variant': '#F8FBFF',
          primary: '#2563EB',
          'primary-darken-1': '#1D4ED8',
          secondary: '#1E3A5F',
          accent: '#0EA5E9',
          error: '#EF4444',
          warning: '#F59E0B',
          success: '#10B981',
          info: '#0EA5E9',
          'on-background': '#0F172A',
          'on-surface': '#0F172A',
          'on-primary': '#ffffff',
          'on-secondary': '#ffffff',
        },
      },
      'legacy-dark': {
        dark: true,
        colors: {
          background: '#0A192F',
          surface: '#112240',
          'surface-variant': '#1D2D50',
          primary: '#00F2FF',
          secondary: '#E6F1FF',
          accent: '#00F2FF',
          error: '#FF5252',
          warning: '#FFB74D',
          success: '#4CAF50',
          info: '#00F2FF',
          'on-background': '#E6F1FF',
          'on-surface': '#E6F1FF',
          'on-primary': '#0A192F',
        },
      },
    },
  },
  defaults: {
    VBtn: { variant: 'flat', rounded: 'lg' },
    VTextField: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VSelect: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VAutocomplete: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VCombobox: { rounded: 'lg' },
    VTextarea: { variant: 'outlined', density: 'compact', rounded: 'lg' },
    VCard: { rounded: 'xl', variant: 'flat' },
    VChip: { rounded: 'pill', size: 'small' },
    VDialog: { maxWidth: 600 },
    VMenu: { transition: 'scale-transition' },
  },
});
