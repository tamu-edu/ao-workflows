import * as core from '@actions/core';
import {execSync} from 'child_process'
import semverGt from 'semver/functions/gt'
import fs from 'fs';

async function compareVersions() {
  execSync('git show origin/main:metadata.rb > metadata-main.rb')
  const mainVersionData = fs.readFileSync('metadata-main.rb', 'utf-8')
  const currVersionData = fs.readFileSync('metadata.rb', 'utf-8')
  const mainVersion = mainVersionData.match(/version ['"]([0-9\.]+)['"]/)
  const currVersion = currVersionData.match(/version ['"]([0-9\.]+)['"]/)
  if (mainVersion && currVersion) {
    if (!semverGt(currVersion[1], mainVersion[1])) {
      core.setFailed('Current version is not greater than main branch version')
    } else {
      console.log('Version is greater than main branch')
    }
  } else {
    core.setFailed('Could not find and compare main and current versions')
  }
}

void compareVersions();