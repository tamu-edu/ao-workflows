import * as core from '@actions/core';
import * as http from '@actions/http-client';

interface Project {
    id: number;
    name: string;
}

interface ProjectSyncResponse {
    id?: number;
    project_update?: number;
}

interface ProjectUpdateStatus {
    id: number;
    status: 'new' | 'pending' | 'waiting' | 'running' | 'successful' | 'failed' | 'error' | 'canceled';
    name: string;
    failed: boolean;
}

interface SyncResult {
    projectId: number;
    projectName: string;
    success: boolean;
    error?: string;
}

async function syncProjects() {
    const client = new http.HttpClient('project-sync-action');
    try {
        const ahHost = core.getInput('ah_host', { required: true });
        const ahToken = core.getInput('ah_token', { required: true });
        const projectName = core.getInput('project_name');
        const syncTimeout = parseInt(core.getInput('sync_timeout') || '300');
        const syncPollInterval = parseInt(core.getInput('sync_poll_interval') || '10');
        const syncRetryAttempts = parseInt(core.getInput('sync_retry_attempts') || '3');
        const retryDelay = parseInt(core.getInput('retry_delay') || '10');
        const projectSyncDelay = parseInt(core.getInput('project_sync_delay') || '5');

        const baseUrl = ahHost.startsWith('http') ? ahHost : `https://${ahHost}`;
        const headers = {
            'Authorization': `Bearer ${ahToken}`,
            'Content-Type': 'application/json'
        };

        // Get the list of projects from the Ansible Hub
        const projects = await getProjects(client, baseUrl, headers);
        if (!projects || projects.length === 0) {
            core.setFailed(`No projects found`);
            return;
        }

        const results: SyncResult[] = [];

        if (projectName && projectName.trim() != '') {
            const project = projects.find(p => p.name === projectName);
            if (!project) {
                core.setFailed(`Project not found: ${projectName}`);
                return;
            }
            core.info(`Syncing project: ${projectName}`);
            const result = await checkAndSyncProject(
                client, baseUrl, headers, project.id, project.name,
                syncTimeout, syncPollInterval, syncRetryAttempts, retryDelay
            );
            results.push(result);
        } else {
            core.info(`Syncing all projects`);
            for (const project of projects) {
                const result = await checkAndSyncProject(
                    client, baseUrl, headers, project.id, project.name,
                    syncTimeout, syncPollInterval, syncRetryAttempts, retryDelay
                );
                results.push(result);

                // Add delay between starting each project sync (except for the last one)
                if (project !== projects[projects.length - 1]) {
                    core.info(`Waiting ${projectSyncDelay} seconds before starting next project sync...`);
                    await sleep(projectSyncDelay * 1000);
                }
            }
        }

        // Check if any projects failed
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
            core.error('The following projects failed to sync:');
            failures.forEach(f => {
                core.error(`  - ${f.projectName} (ID: ${f.projectId}): ${f.error}`);
            });
            core.setFailed(`${failures.length} project(s) failed to sync`);
        } else {
            core.info(`All project(s) synced successfully`);
        }
    } catch (error) {
        core.setFailed(`Action failed: ${error}`);
    } finally {
        client.dispose();
    }
}

async function getProjects(client: http.HttpClient, baseUrl: string, headers: any): Promise<Project[]> {
    const response = await client.get(`${baseUrl}/api/controller/v2/projects/`, headers);

    if (response.message.statusCode !== 200) {
        core.setFailed(`Failed to get projects: ${response.message.statusCode}`);
        return [];
    }

    const body = await response.readBody();
    const data = JSON.parse(body);
    return data.results || [];
}

async function checkAndSyncProject(
    client: http.HttpClient,
    baseUrl: string,
    headers: any,
    projectId: number,
    projectName: string,
    syncTimeout: number,
    syncPollInterval: number,
    syncRetryAttempts: number,
    retryDelay: number
): Promise<SyncResult> {
    for (let attempt = 1; attempt <= syncRetryAttempts; attempt++) {
        try {
            // Check if project can be updated
            const projectResponse = await client.get(`${baseUrl}/api/controller/v2/projects/${projectId}/update/`, headers);
            const body = await projectResponse.readBody();
            const data = JSON.parse(body);

            if (!data.can_update) {
                core.info(`Project ${projectName} (ID: ${projectId}) cannot be updated. Skipping...`);
                return {
                    projectId,
                    projectName,
                    success: true
                };
            }

            // Trigger the sync
            core.info(`Starting sync for project ${projectName} (ID: ${projectId}) - Attempt ${attempt}/${syncRetryAttempts}`);
            const response = await client.post(`${baseUrl}/api/controller/v2/projects/${projectId}/update/`, '', headers);

            if (response.message.statusCode !== 202) {
                const responseBody = await response.readBody();
                throw new Error(`Failed to start sync: HTTP ${response.message.statusCode} - ${responseBody}`);
            }

            // Get the project update ID from the response
            const syncResponseBody = await response.readBody();
            const syncResponse: ProjectSyncResponse = JSON.parse(syncResponseBody);
            const updateId = syncResponse.project_update || syncResponse.id;

            if (!updateId) {
                throw new Error('No project update ID returned from sync request');
            }

            core.info(`Project update started with ID: ${updateId}`);

            // Wait for the sync to complete
            const success = await waitForProjectUpdate(
                client,
                baseUrl,
                headers,
                updateId,
                projectName,
                syncTimeout,
                syncPollInterval
            );

            if (success) {
                core.info(`✓ Project ${projectName} (ID: ${projectId}) synced successfully`);
                return {
                    projectId,
                    projectName,
                    success: true
                };
            } else {
                throw new Error('Project sync failed or timed out');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            core.warning(`Attempt ${attempt}/${syncRetryAttempts} failed for project ${projectName}: ${errorMessage}`);

            if (attempt < syncRetryAttempts) {
                core.info(`Waiting ${retryDelay} seconds before retry...`);
                await sleep(retryDelay * 1000);
            } else {
                core.error(`✗ Project ${projectName} (ID: ${projectId}) failed after ${syncRetryAttempts} attempts`);
                return {
                    projectId,
                    projectName,
                    success: false,
                    error: errorMessage
                };
            }
        }
    }

    // Should never reach here, but TypeScript needs a return
    return {
        projectId,
        projectName,
        success: false,
        error: 'Unknown error'
    };
}

async function waitForProjectUpdate(
    client: http.HttpClient,
    baseUrl: string,
    headers: any,
    updateId: number,
    projectName: string,
    timeout: number,
    pollInterval: number
): Promise<boolean> {
    const startTime = Date.now();
    const maxTime = timeout * 1000;

    while (Date.now() - startTime < maxTime) {
        try {
            const response = await client.get(`${baseUrl}/api/controller/v2/project_updates/${updateId}/`, headers);

            if (response.message.statusCode !== 200) {
                core.warning(`Failed to get project update status: ${response.message.statusCode}`);
                await sleep(pollInterval * 1000);
                continue;
            }

            const body = await response.readBody();
            const status: ProjectUpdateStatus = JSON.parse(body);

            core.info(`Project ${projectName} sync status: ${status.status}`);

            if (status.status === 'successful') {
                return true;
            } else if (status.status === 'failed' || status.status === 'error' || status.status === 'canceled') {
                core.error(`Project sync ended with status: ${status.status}`);
                return false;
            }

            // Status is still running/pending/waiting, continue polling
            await sleep(pollInterval * 1000);
        } catch (error) {
            core.warning(`Error checking project update status: ${error}`);
            await sleep(pollInterval * 1000);
        }
    }

    core.error(`Timeout waiting for project ${projectName} to complete after ${timeout} seconds`);
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

void syncProjects();
