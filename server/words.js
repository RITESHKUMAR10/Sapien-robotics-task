'use strict';

const single = `apple banana guitar rocket pizza elephant bicycle castle dragon umbrella
volcano penguin sandwich telescope rainbow pyramid snowman mushroom octopus lighthouse
scissors butterfly helicopter pineapple skeleton wizard tornado submarine kangaroo hammock
camera candle ladder compass anchor balloon bridge cactus diamond dolphin
envelope fireworks giraffe hamburger igloo jellyfish keyboard lantern mermaid necklace
owl parachute quicksand robot scarecrow tractor unicorn vampire waterfall xylophone
zebra airplane backpack cupcake donut eagle flamingo ghost headphones
island jungle kettle lollipop magnet notebook ostrich pencil queen rabbit
sailboat toothbrush windmill astronaut bat bell broom cloud crown
drum feather flute globe hat key lamp moon nest pirate`.split(/\s+/);

const multi = [
  'ice cream', 'hot dog', 'treasure map', 'police car', 'birthday cake',
  'fire truck', 'roller coaster', 'tooth fairy', 'space station', 'swimming pool',
  'spider web', 'traffic light', 'paper plane', 'snow globe', 'magic wand',
  'sea horse', 'tennis racket', 'light bulb', 'bubble bath', 'fish bowl',
];

module.exports = [...single, ...multi];
