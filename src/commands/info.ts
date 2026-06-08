import fs from 'fs';
import os from 'os';
import path from 'path';
import { version } from '../../package.json';
import { getEntriesFlat } from '../storage';
import { loadAliases } from '../alias';
import { loadConfirmKeys } from '../confirm';
import { getGlobalStoreDirPath, getConfigFilePath, isDataDirectoryFromEnv } from '../utils/paths';
import { findProjectFile } from '../store';
import { color } from '../formatting';
import { getBinaryName } from '../utils/binaryName';
import { isJsonMode, setResult } from '../utils/output';

export function showInfo(): void {
  const entryCount = Object.keys(getEntriesFlat()).length;
  const aliasCount = Object.keys(loadAliases()).length;
  const confirmCount = Object.keys(loadConfirmKeys()).length;

  if (isJsonMode()) {
    setResult({
      version,
      entries: entryCount,
      aliases: aliasCount,
      confirmKeys: confirmCount,
      dataDir: getGlobalStoreDirPath(),
      dataDirFromEnv: isDataDirectoryFromEnv(),
      configFile: getConfigFilePath(),
      projectFile: findProjectFile() ?? null,
    });
    return;
  }

  console.log();

  const label = (name: string, value: string) => {
    const pad = ' '.repeat(Math.max(2, 18 - name.length));
    console.log(`  ${color.gray(name + ':')}${pad}${value}`);
  };

  label('Version', color.cyan(version));
  label('Entries', String(entryCount));
  label('Aliases', String(aliasCount));
  label('Confirm keys', String(confirmCount));

  console.log();

  const dataSource = isDataDirectoryFromEnv() ? color.gray(' (RVR_DATA_DIR)') : '';
  label('Data', getGlobalStoreDirPath() + dataSource);
  label('Config', getConfigFilePath());
  const projectFile = findProjectFile();
  label('Project', projectFile ?? color.gray('none'));

  console.log();

  const shell = process.env.SHELL ?? '';
  let rcFile: string | null = null;
  const home = os.homedir();
  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else if (shell.endsWith('/bash')) {
    const bashProfile = path.join(home, '.bash_profile');
    const bashrc = path.join(home, '.bashrc');
    rcFile = process.platform === 'darwin' && fs.existsSync(bashProfile) ? bashProfile : bashrc;
  }
  const bin = getBinaryName();
  const rcContent = rcFile && fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
  if (rcContent.includes(`${bin} config completions`) || rcContent.includes(`${bin} completions`)) {
    label('Completions', `${color.green('installed')} (${rcFile})`);
  } else {
    label('Completions', `${color.yellow('not installed')} (run: ${bin} config completions install)`);
  }

  console.log();
}
