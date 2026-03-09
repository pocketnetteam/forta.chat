export function usePostBoost() {
  const showDonateModal = ref(false);
  const boostAddress = ref("");

  const openBoost = (authorAddress: string) => {
    boostAddress.value = authorAddress;
    showDonateModal.value = true;
  };

  const closeBoost = () => {
    showDonateModal.value = false;
    boostAddress.value = "";
  };

  return { showDonateModal, boostAddress, openBoost, closeBoost };
}
