import * as core from '@actions/core';
import * as http from '@actions/http-client';
import fs from 'fs';
import YAML from 'yaml';

interface CollectionVersion {
  pulp_href: string;
}

interface Repository {
  pulp_href: string;
}

interface ApiResponse<T> {
  count: number;
  results: T[];
}

async function approveCollection() {
  const client = new http.HttpClient('collection-approve-action');
  
  try {
    const ahHost = core.getInput('ah_host', { required: true });
    const ahToken = core.getInput('ah_token', { required: true });
    const namespace = core.getInput('namespace', { required: true });
    const name = core.getInput('name', { required: true });
    const version = core.getInput('version') || getVersionFromGalaxyYml();
    const timeout = parseInt(core.getInput('timeout') || '300');
    const interval = parseFloat(core.getInput('interval') || '10.0');

    if (!version) {
      core.setFailed('Version must be provided either as input or in galaxy.yml');
      return;
    }

    const baseUrl = ahHost.startsWith('http') ? ahHost : `https://${ahHost}`;
    const headers = {
      'Authorization': `Token ${ahToken}`,
      'Content-Type': 'application/json'
    };

    core.info(`Approving collection ${namespace}.${name}:${version}`);

    // Check if this is a standalone hub or AAP
    const isStandalone = await checkIfStandalone(client, baseUrl, headers);
    
    if (isStandalone) {
      await approveStandalone(client, baseUrl, headers, namespace, name, version, timeout, interval);
    } else {
      await approveAAP(client, baseUrl, headers, namespace, name, version, timeout, interval);
    }

    core.info('Collection approved successfully');
    core.setOutput('approved', 'true');
  } catch (error) {
    core.setFailed(`Action failed: ${error}`);
  } finally {
    client.dispose();
  }
}

async function checkIfStandalone(client: http.HttpClient, baseUrl: string, headers: any): Promise<boolean> {
  try {
    const response = await client.get(`${baseUrl}/api/`, headers);
    return response.message.statusCode === 404;
  } catch {
    return true; // Assume standalone if error
  }
}

async function approveStandalone(
  client: http.HttpClient, 
  baseUrl: string, 
  headers: any, 
  namespace: string, 
  name: string, 
  version: string, 
  timeout: number, 
  interval: number
) {
  const endpoint = `${baseUrl}/api/galaxy/v3/collections/${namespace}/${name}/versions/${version}/move/staging/published/`;
  
  let attempts = 0;
  const maxAttempts = Math.floor(timeout / interval);
  
  while (attempts < maxAttempts) {
    try {
      const response = await client.post(endpoint, '', headers);
      
      if (response.message.statusCode === 202) {
        core.info('Collection moved from staging to published');
        return;
      }
    } catch (error) {
      core.info(`Attempt ${attempts + 1} failed, retrying in ${interval} seconds...`);
    }
    
    await sleep(interval * 1000);
    attempts++;
  }
  
  throw new Error(`Failed to approve collection after ${attempts} attempts`);
}

async function approveAAP(
  client: http.HttpClient, 
  baseUrl: string, 
  headers: any, 
  namespace: string, 
  name: string, 
  version: string, 
  timeout: number, 
  interval: number
) {
  // Wait for collection version to be available
  const cvEndpoint = `${baseUrl}/api/galaxy/pulp/api/v3/content/ansible/collection_versions/`;
  const cvParams = `?namespace=${namespace}&name=${name}&version=${version}`;
  
  let collectionVersion: CollectionVersion | null = null;
  let attempts = 0;
  const maxAttempts = Math.floor(timeout / interval);
  
  // Wait for collection version to exist
  while (!collectionVersion && attempts < maxAttempts) {
    try {
      const response = await client.get(`${cvEndpoint}${cvParams}`, headers);
      const body = await response.readBody();
      const data: ApiResponse<CollectionVersion> = JSON.parse(body);
      
      if (data.count > 0) {
        collectionVersion = data.results[0];
        break;
      }
    } catch (error) {
      core.info(`Waiting for collection version to be available... (attempt ${attempts + 1})`);
    }
    
    await sleep(interval * 1000);
    attempts++;
  }
  
  if (!collectionVersion) {
    throw new Error('Collection version not found after waiting');
  }

  // Get repository pulp_hrefs
  const reposEndpoint = `${baseUrl}/api/galaxy/pulp/api/v3/repositories/`;
  
  const [stagingRepo, publishedRepo] = await Promise.all([
    getRepository(client, `${reposEndpoint}?name=staging`, headers),
    getRepository(client, `${reposEndpoint}?name=published`, headers)
  ]);
  
  if (!stagingRepo || !publishedRepo) {
    throw new Error('Could not find staging or published repositories');
  }

  // Move collection from staging to published
  const moveEndpoint = `${baseUrl}${stagingRepo.pulp_href}move_collection_version/`;
  const moveData = {
    collection_versions: [collectionVersion.pulp_href],
    destination_repositories: [publishedRepo.pulp_href]
  };

  const response = await client.post(moveEndpoint, JSON.stringify(moveData), headers);
  
  if (response.message.statusCode !== 202) {
    const body = await response.readBody();
    throw new Error(`Failed to move collection: ${body}`);
  }
  
  core.info('Collection moved from staging to published');
}

async function getRepository(client: http.HttpClient, url: string, headers: any): Promise<Repository | null> {
  try {
    const response = await client.get(url, headers);
    const body = await response.readBody();
    const data: ApiResponse<Repository> = JSON.parse(body);
    
    return data.count > 0 ? data.results[0] : null;
  } catch {
    return null;
  }
}

function getVersionFromGalaxyYml(): string | null {
  try {
    if (fs.existsSync('galaxy.yml')) {
      const galaxyData = YAML.parse(fs.readFileSync('galaxy.yml', 'utf-8'));
      return galaxyData.version || null;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

void approveCollection();