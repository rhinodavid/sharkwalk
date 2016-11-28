const axios = require('axios');
const assessor = require('./riskHelpers/riskAssessors');
const routeProfiler = require('./riskHelpers/routeProfiler');
const pathfinderHelpers = require('./riskHelpers/pathfinderHelpers');
const turf = require('@turf/turf');

const buildRiskPromise = function buildRiskPromise(input) {
  if (Array.isArray(input) && typeof input[0] === 'number') {
    // a single coordinate
    return assessor.getRiskForCoordinates(input);
  }

  if (Array.isArray(input) && Array.isArray(input[0])) {
    // an array of coordinate arrays
    return Promise.all(input.map(coord => assessor.getRiskForCoordinates(coord)));
  }

  if (!Array.isArray(input)) {
    // a geojson object
    return assessor.decoratePointWithRisk(input);
  }

  if (Array.isArray(input) && !Array.isArray(input[0]) && typeof input[0] === 'object') {
    // an array of geojson objects
    return Promise.all(input.map(point => assessor.decoratePointWithRisk(point)));
  }
  throw new Error('Unexpected input format.');
};

const getRisk = function getRisk(request, response) {
  const input = request.body.point;
  return buildRiskPromise(input)
  .then(risk => response.status(200).json({ risk }))
  .catch(e => response.status(400).json({
    error: {
      message: e.message,
    },
  }));
};

const getRiskPath = function getRiskPath(request, response) {
  const input = request.body;
  if (!Array.isArray(input)) {
    return response.status(400).json({
      error: {
        message: 'Input must be an array of objects with key path.',
      },
    });
  }
  const risksPromises = [];
  input.forEach(route => risksPromises.push(assessor.getRiskForCoordinatesArray(route.path)));
  return Promise.all(risksPromises)
    .then(riskArrays => riskArrays.map(risks => routeProfiler.profileRoute(risks)))
    .then(result => response.status(200).json(result))
    .catch(e => response.status(400).json({
      error: {
        message: e.message,
      },
    }));
};

const findPath = function findPath(request, response) {
  const tripServiceUrl = process.env.TRIP_SERVICE_URL;
  if (!tripServiceUrl) {
    throw new Error('No URL for the Trip Service set in TRIP_SERVICE_URL');
  }

  const origin = turf.point([+request.query.origin.lng, +request.query.origin.lat]);
  const destination = turf.point([+request.query.destination.lng, +request.query.destination.lat]);

  let rawPaths;
  return Promise.all([
    pathfinderHelpers.findPathwayAroundRiskWeight(origin.geometry, destination.geometry, 2),
    pathfinderHelpers.findPathwayAroundRiskWeight(origin.geometry, destination.geometry, 10),
  ])
    .then((unprocessedPaths) => {
      if (JSON.stringify(unprocessedPaths[0]) === JSON.stringify(unprocessedPaths[1])) {
        rawPaths = unprocessedPaths[0];
      } else {
        rawPaths = unprocessedPaths;
      }
      return axios.post(`${tripServiceUrl}/routes`, rawPaths);
    })
    .then((tripResponse) => {
      const processedPaths = tripResponse.data;
      const risksPromises = [];
      processedPaths.forEach(route =>
        risksPromises.push(assessor.getRiskForCoordinatesArray(route.path)));
      return Promise.all(risksPromises)
        .then(riskArrays => riskArrays.map(risks => routeProfiler.profileRoute(risks)))
        .then(routes => routes.map((route, i) =>
          Object.assign(route, {
            riskWeight: rawPaths[i].riskWeight,
            route: processedPaths[i].route,
            path: processedPaths[i].path,
          })))
        .then(result => response.status(200).json(result))
        .catch(e => response.status(400).json({
          error: {
            message: e.message,
          },
        }));
    });
};

module.exports = {
  getRisk,
  getRiskPath,
  findPath,
  axios,
};
