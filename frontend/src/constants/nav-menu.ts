/**
 * nav-menu.ts — menu chính (dùng chung giao diện máy tính + điện thoại), chia nhóm như App nội bộ.
 * 29/09/2026: thay dải tab ngang 11 mục + 2 dropdown bằng menu dọc có nhóm.
 */
export interface NavItem {
  path: string;
  label: string;
  icon: string; // mdi-*
  /** Khớp cả trang con bắt đầu bằng tiền tố này (mặc định = path). */
  matchPrefix?: string;
  /** Chỉ sáng khi đúng đường dẫn. */
  exact?: boolean;
  /** Không sáng khi đường dẫn thuộc các tiền tố này (trang con có mục menu riêng). */
  exclude?: string[];
}
export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ path: '/', label: 'Tổng quan', icon: 'mdi-view-dashboard-outline', exact: true }],
  },
  {
    label: 'Bán hàng',
    items: [
      { path: '/chat', label: 'Tin nhắn', icon: 'mdi-message-text-outline' },
      { path: '/friends', label: 'Bạn bè', icon: 'mdi-account-heart-outline' },
      { path: '/contacts', label: 'Khách hàng', icon: 'mdi-account-box-multiple-outline' },
      { path: '/leads/stuck', label: 'KH đình trệ', icon: 'mdi-alert-decagram-outline' },
      { path: '/appointments', label: 'Lịch hẹn', icon: 'mdi-calendar-clock-outline' },
      { path: '/groups', label: 'Nhóm Zalo', icon: 'mdi-account-group-outline' },
    ],
  },
  {
    label: 'Tự động hoá',
    items: [
      { path: '/automation/bot/triggers', label: 'Bot tự động', icon: 'mdi-robot-outline', matchPrefix: '/automation/bot' },
      { path: '/chao-hang', label: 'Chào hàng', icon: 'mdi-storefront-outline' },
      { path: '/group-posts', label: 'Đăng nhóm', icon: 'mdi-bullhorn-outline' },
      { path: '/automation', label: 'Mẫu tin & luật', icon: 'mdi-lightning-bolt-outline', exclude: ['/automation/bot'] },
    ],
  },
  {
    label: 'Báo cáo',
    items: [
      { path: '/analytics', label: 'Phân tích', icon: 'mdi-chart-line' },
      { path: '/reports', label: 'Báo cáo', icon: 'mdi-file-chart-outline' },
    ],
  },
  {
    label: 'Cài đặt',
    items: [
      { path: '/settings/crm/ai-auto-reply', label: 'AI tự trả lời', icon: 'mdi-robot-happy-outline' },
      { path: '/settings/channels/zalo', label: 'Tài khoản Zalo', icon: 'mdi-cellphone-link' },
      { path: '/settings', label: 'Tất cả cài đặt', icon: 'mdi-cog-outline', exclude: ['/settings/crm/ai-auto-reply', '/settings/channels/zalo'] },
    ],
  },
];

/** Hàm thuần: mục menu có đang được chọn với đường dẫn hiện tại không. */
export function isNavActive(item: NavItem, path: string): boolean {
  if (item.exclude?.some((p) => path === p || path.startsWith(p + '/'))) return false;
  if (item.exact) return path === item.path;
  const prefix = item.matchPrefix ?? item.path;
  return path === prefix || path.startsWith(prefix + '/');
}

/** Trang không có mục menu riêng nhưng cần tiêu đề (mở từ menu tài khoản). */
const EXTRA_TITLES: Record<string, string> = {
  '/profile': 'Hồ sơ nick Zalo',
  '/settings/personal/profile': 'Hồ sơ của tôi',
};

/** Tên mục menu đang chọn (hiện trên thanh trên). */
export function activeNavLabel(path: string): string {
  if (EXTRA_TITLES[path]) return EXTRA_TITLES[path];
  for (const g of NAV_GROUPS) for (const it of g.items) if (isNavActive(it, path)) return it.label;
  return '';
}
