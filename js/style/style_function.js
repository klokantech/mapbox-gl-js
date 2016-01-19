'use strict';

var createMapboxGLFunction = require('mapbox-gl-function');

function createBackwardsCompatible(reference, parameters) {
    var innerFun = create(reference, parameters);
    var outerFun = function(zoom) {
        return innerFun({$zoom: zoom}, {});
    };
    outerFun.isFeatureConstant = innerFun.isFeatureConstant;
    outerFun.isGlobalConstant = innerFun.isGlobalConstant;
    return outerFun;
}

function create(reference, parameters) {
    if (parameters && parameters.stops) {
        var domain = [];
        var range = [];

        for (var i = 0; i < parameters.stops.length; i++) {
            domain.push(parameters.stops[i][0]);
            range.push(parameters.stops[i][1]);
        }

        parameters.domain = domain;
        parameters.range = range;
        delete parameters.stops;

        if (reference.function === 'interpolated') {
            parameters.type = 'exponential';
        } else {
            parameters.domain.shift();
            parameters.type = 'interval';
        }
    }

    return createMapboxGLFunction(parameters);
}

module.exports = {
    create: create,
    createBackwardsCompatible: createBackwardsCompatible
};
