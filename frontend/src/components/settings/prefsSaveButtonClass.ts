/** Shared Save button style for My Preferences: muted when idle, brand when dirty. */
import { btnSaveActive, btnSaveIdle } from '../../ui/tokens';

export function prefsSaveBtnClass(active: boolean): string {
  return active ? btnSaveActive : btnSaveIdle;
}
