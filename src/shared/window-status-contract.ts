/** Only the desktop renderer may change window-management policy. */
export interface WindowStatus {
  closeToTray: boolean;
  trayAvailable: boolean;
}
