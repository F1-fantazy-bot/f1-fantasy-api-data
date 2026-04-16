const { BlobServiceClient } = require('@azure/storage-blob');

const BLOB_NAME = 'f1-fantasy-api-data.json';

async function uploadDataToAzureStorage(data, leagueCode) {
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
  const blobPath = leagueCode ? `leagues/${leagueCode}/${BLOB_NAME}` : BLOB_NAME;
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  const jsonData = JSON.stringify(data, null, 2);

  await blockBlobClient.upload(jsonData, jsonData.length, {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });

  console.log(`Data uploaded successfully to ${blobPath}`);
}

module.exports = { uploadDataToAzureStorage };
