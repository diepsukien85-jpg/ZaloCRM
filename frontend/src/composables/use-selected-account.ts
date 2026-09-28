/**
 * Shared composable for picking which Zalo account to operate on.
 * Used by Groups, Friends, and other account-scoped views.
 */
import { ref, onMounted } from 'vue';
import { useZaloAccounts } from './use-zalo-accounts';

export function useSelectedAccount() {
  const { accounts, fetchAccounts, loading } = useZaloAccounts();
  const selectedAccountId = ref(localStorage.getItem('selected-zalo-account') || '');

  function selectAccount(id: string) {
    selectedAccountId.value = id;
    localStorage.setItem('selected-zalo-account', id);
  }

  onMounted(async () => {
    await fetchAccounts();
    // Chưa chọn, hoặc id lưu trong localStorage không còn tồn tại → lấy account đầu tiên
    const stillExists = accounts.value.some((a) => a.id === selectedAccountId.value);
    if ((!selectedAccountId.value || !stillExists) && accounts.value.length > 0) {
      selectAccount(accounts.value[0].id);
    }
  });

  return { accounts, selectedAccountId, selectAccount, loading };
}
