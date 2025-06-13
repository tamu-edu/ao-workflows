import * as core from '@actions/core';
import {execSync} from 'child_process'
import semverGt from 'semver/functions/gt'
import fs from 'fs';
import YAML from 'yaml';

async function compareVersions() {
  try {
    execSync('git show origin/main:galaxy.yml > galaxy-main.yml')
  } catch {
    console.log('Could not fetch main branch galaxy.yml, continuing with current version')
    return;
  }
  const galaxyMainData = YAML.parse(fs.readFileSync('galaxy-main.yml', 'utf-8'));
  const galaxyCurrData = YAML.parse(fs.readFileSync('galaxy.yml', 'utf-8'));

  if (galaxyMainData && galaxyCurrData) {
    const mainVersion = galaxyMainData.version;
    const currVersion = galaxyCurrData.version;
    if (mainVersion && currVersion) {
      if (!semverGt(currVersion, mainVersion)) {
        core.setFailed('Current version is not greater than main branch version')
      } else {
        console.log('Version is greater than main branch')
      }
    } else {
      core.setFailed('Could not find and compare main and current versions')
    }
  } else {
    core.setFailed('Could not parse galaxy.yml files')
  }
}

void compareVersions();