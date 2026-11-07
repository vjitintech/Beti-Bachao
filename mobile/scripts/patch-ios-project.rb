# Adds the native Swift sources to the generated Capacitor Xcode project.
# Usage: ruby patch-ios-project.rb path/to/App.xcodeproj File1.swift File2.swift ...
require 'xcodeproj'

proj_path = ARGV.shift
project = Xcodeproj::Project.open(proj_path)
target = project.targets.find { |t| t.name == 'App' } or abort('patch-ios: App target not found')
group = project.main_group['App'] or abort('patch-ios: App group not found')

ARGV.each do |name|
  next if group.files.any? { |f| f.path == name }
  ref = group.new_reference(name)
  target.add_file_references([ref])
end
group.new_reference('App.entitlements') unless group.files.any? { |f| f.path == 'App.entitlements' }

target.build_configurations.each do |c|
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  c.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2' # iPhone + iPad
  c.build_settings['SWIFT_VERSION'] ||= '5.0'
end
project.save
puts "patch-ios: added #{ARGV.join(', ')}"
