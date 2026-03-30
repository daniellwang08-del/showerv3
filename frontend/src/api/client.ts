import axios from 'axios';

export const API_BASE_URL = '/api/v1';

export const apiClient = axios.create({ 
  baseURL: API_BASE_URL,
  withCredentials: true 
});
