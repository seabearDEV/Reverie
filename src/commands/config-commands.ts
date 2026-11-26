import { color, resetColorCache } from '../formatting';
import { loadConfig, getConfigSetting, setConfigSetting, unsetConfigSetting, VALID_CONFIG_KEYS } from '../config';
import { printError } from './helpers';
import { debug } from '../utils/debug';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, setResult } from '../utils/output';

export function handleConfig(setting?: string, value?: string, options?: { list?: boolean }) {
  debug('handleConfig called', { setting, value, options });
  // Handle the --list option
  if (options?.list) {
    if (isJsonMode()) {
      setResult({ settings: [
        { key: 'colors', description: 'Enable/disable colored output (true/false)' },
        { key: 'theme', description: 'UI theme (default/dark/light)' },
      ] });
      return;
    }
    console.log();
    console.log(`${color.green('colors'.padEnd(15))}: Enable/disable colored output (true/false)`);
    console.log(`${color.green('theme'.padEnd(15))}: UI theme (default/dark/light)`);
    return;
  }

  // If no setting provided, show all settings
  if (!setting) {
    const config = loadConfig();

    if (isJsonMode()) {
      setResult(config);
      return;
    }

    console.log();

    for (const [key, val] of Object.entries(config)) {
      console.log(`${color.green(key.padEnd(15))}: ${val}`);
    }

    console.log(`\nUse \`${getBinaryName()} config --help\` to see available options`);
    return;
  }

  // If only setting provided, show that setting's value
  if (!value) {
    const currentValue = getConfigSetting(setting);
    if (currentValue !== null) {
      console.log(`${color.green(setting)}: ${currentValue}`);
      return { [setting]: currentValue };
    }
    printError(`Setting '${setting}' does not exist`, 'NOT_FOUND');
    return undefined;
  }

  // If both setting and value provided, update the setting
  setConfigSetting(setting, value);
  resetColorCache();
  console.log(`Updated ${color.green(setting)} to: ${value}`);
  return { [setting]: value };
}

export function configSet(setting: string, value: string): { key: string; value: string; previous: unknown } | undefined {
  debug('configSet called', { setting, value });
  try {
    const previous = getConfigSetting(setting);

    setConfigSetting(setting, value);
    resetColorCache();
    console.log(`Changing ${setting} from ${previous} to ${value}`);
    console.log(`${setting} set to ${value}`);
    return { key: setting, value, previous };
  } catch (error) {
    // One code in both modes (#203): printError routes to the envelope in JSON mode.
    printError(`Error setting config ${setting}: ${String(error)}`, 'IO');
    return undefined;
  }
}

/**
 * `config unset <key>` (#213): remove the setting from config.json so it
 * follows the default again, including later changes to the default.
 */
export function configUnset(setting: string): { key: string; value: unknown; previous: unknown } | undefined {
  debug('configUnset called', { setting });
  if (!(VALID_CONFIG_KEYS as readonly string[]).includes(setting)) {
    printError(`Setting '${setting}' does not exist`, 'NOT_FOUND');
    return undefined;
  }
  try {
    const previous = getConfigSetting(setting);
    unsetConfigSetting(setting);
    resetColorCache();
    const value = getConfigSetting(setting);
    console.log(`${setting} reset to its default: ${String(value)} (was ${String(previous)})`);
    return { key: setting, value, previous };
  } catch (error) {
    printError(`Error unsetting config ${setting}: ${String(error)}`, 'IO');
    return undefined;
  }
}
