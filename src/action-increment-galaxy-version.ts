import * as core from '@actions/core';
import fs from 'fs';
import YAML from 'yaml';

async function incrementVersion() {
  try {
    const timezone = core.getInput('timezone') || 'America/Chicago';
    
    // Create date in specified timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === 'year')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    const day = parts.find(p => p.type === 'day')?.value || '';
    const hour = parts.find(p => p.type === 'hour')?.value || '';
    const minute = parts.find(p => p.type === 'minute')?.value || '';
    
    // Format: YEAR.MONTHDAY.HOURMINUTE (remove leading zeros for semver compliance)
    const monthDay = parseInt(`${month}${day}`, 10).toString();
    const hourMin = parseInt(`${hour}${minute}`, 10).toString();
    const newVersion = `${year}.${monthDay}.${hourMin}`;
    
    // Read current galaxy.yml
    if (!fs.existsSync('galaxy.yml')) {
      core.setFailed('galaxy.yml not found in current directory');
      return;
    }
    
    const galaxyData = YAML.parse(fs.readFileSync('galaxy.yml', 'utf-8'));
    
    if (!galaxyData) {
      core.setFailed('Could not parse galaxy.yml');
      return;
    }
    
    const oldVersion = galaxyData.version || 'unknown';
    galaxyData.version = newVersion;
    
    // Write updated galaxy.yml
    fs.writeFileSync('galaxy.yml', YAML.stringify(galaxyData));
    
    console.log(`Version updated from ${oldVersion} to ${newVersion} (${timezone} timezone)`);
    core.setOutput('version', newVersion);
    core.setOutput('previous-version', oldVersion);
    
  } catch (error) {
    core.setFailed(`Failed to increment version: ${error}`);
  }
}

void incrementVersion();