import { color, resetColorCache } from '../formatting';
import { loadConfig, getConfigSetting, setConfigSetting } from '../config';
import { printError } from './helpers';
import { debug } from '../utils/debug';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, setResult, failJson } from '../utils/output';

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
    if (isJsonMode()) {
      failJson('IO', `Error setting config ${setting}: ${String(error)}`);
    } else {
      printError(`Error setting config ${setting}: ${String(error)}`);
    }
    return undefined;
  }
}
