'use strict';

var util = require('../../util/util');
var StyleLayer = require('../style_layer');

function LineStyleLayer() {
    StyleLayer.apply(this, arguments);
}

module.exports = LineStyleLayer;

LineStyleLayer.prototype = util.inherit(StyleLayer, {

    getPaintValue: function(name, globalProperties) {
        var output = StyleLayer.prototype.getPaintValue.apply(this, arguments);

        // If the line is dashed, scale the dash lengths by the line
        // width at the previous round zoom level.
        if (output && name === 'line-dasharray') {
            var lineWidth = this.getPaintValue('line-width', {
                $zoom: Math.floor(globalProperties.$zoom),
                $zoomHistory: Infinity
            });
            output.fromScale *= lineWidth;
            output.toScale *= lineWidth;
        }

        return output;
    }

});
