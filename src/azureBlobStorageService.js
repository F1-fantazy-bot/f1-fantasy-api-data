const { BlobServiceClient } = require('@azure/storage-blob');

const DEFAULT_BLOB_NAME = 'league-standings.json';

async function downloadDataFromAzureStorage(leagueCode, blobName = DEFAULT_BLOB_NAME) {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

  if (!connectionString || !containerName) {
    return null;
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobPath = leagueCode ? `leagues/${leagueCode}/${blobName}` : blobName;
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  try {
    const buffer = await blockBlobClient.downloadToBuffer();

    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'BlobNotFound') {
      return null;
    }

    throw err;
  }
}

async function uploadDataToAzureStorage(data, leagueCode, blobName = DEFAULT_BLOB_NAME) {
  if (!data) {
    throw new Error('No data provided for upload');
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

  if (!connectionString || !containerName) {
    throw new Error('Missing required Azure storage configuration');
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobPath = leagueCode ? `leagues/${leagueCode}/${blobName}` : blobName;
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  const jsonData = JSON.stringify(data, null, 2);

  await blockBlobClient.upload(jsonData, jsonData.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });

  console.log(`Data uploaded successfully to ${blobPath}`);
}

module.exports = { uploadDataToAzureStorage, downloadDataFromAzureStorage };
