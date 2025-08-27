import * as core from '@actions/core';
import * as http from '@actions/http-client';

async function syncProjects() {
    const client = new http.HttpClient('project-sync-action');
    try {
        const ahHost = core.getInput('ah_host', { required: true });
        const ahToken = core.getInput('ah_token', { required: true });
        const projectName = core.getInput('project_name');

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

        if (projectName && projectName.trim() != '') {
            const project = projects.find(p => p.name === projectName);
            if (!project) {
                core.setFailed(`Project not found: ${projectName}`);
                return;
            }
            core.info(`Syncing project: ${projectName}`);
            await checkAndSyncProject(client, baseUrl, headers, project.id);
            core.info('Project synced successfully');
        } else {
            core.info(`Syncing all projects`);
            await Promise.all(projects.map(p => checkAndSyncProject(client, baseUrl, headers, p.id)));
        }

        core.info(`Project(s) synced successfully`);
    } catch (error) {
        core.setFailed(`Action failed: ${error}`);
    } finally {
        client.dispose();
    }
}

async function getProjects(client: http.HttpClient, baseUrl: string, headers: any): Promise<any[]> {
    const response = await client.get(`${baseUrl}/api/controller/v2/projects/`, headers);

    if (response.message.statusCode !== 200) {
        core.setFailed(`Failed to get projects: ${response.message.statusCode}`);
        return [];
    }

    const body = await response.readBody();
    const data = JSON.parse(body);
    return data.results || [];
}

async function checkAndSyncProject(client: http.HttpClient, baseUrl: string, headers: any, projectId: number) {
    const projectResponse = await client.get(`${baseUrl}/api/controller/v2/projects/${projectId}/update/`, headers);
    const body = await projectResponse.readBody();
    const data = JSON.parse(body);
    if (!data.can_update) {
        core.info(`Project ${projectId} cannot be updated.  Skipping...`);
        return;
    }

    const response = await client.post(`${baseUrl}/api/controller/v2/projects/${projectId}/update/`, '', headers);
    if (response.message.statusCode !== 202) {
        core.setFailed(`Failed to sync project ${projectId}: ${response.message.statusCode}`);
        return;
    }
}

void syncProjects();
