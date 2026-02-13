namespace :moola_payments do
  desc "Recover stuck payments that have been in :recording status for too long"
  task recover_stuck: :environment do
    minutes = ENV.fetch("STUCK_THRESHOLD_MINUTES", 30).to_i
    puts "Looking for payments stuck in :recording for more than #{minutes} minutes..."

    count = MoolaPayment.reset_stuck_to_matched!(minutes: minutes)

    if count > 0
      puts "Recovered #{count} stuck payment(s)"
    else
      puts "No stuck payments found"
    end
  end

  desc "Show status summary of all MoolaPayments"
  task status: :environment do
    puts "\nMoolaPayment Status Summary"
    puts "=" * 40

    MoolaPayment.statuses.keys.each do |status|
      count = MoolaPayment.where(status: status).count
      puts "#{status.ljust(15)} #{count}"
    end

    puts "-" * 40
    puts "Total:          #{MoolaPayment.count}"

    stuck_count = MoolaPayment.stuck_in_recording.count
    puts "\nStuck in recording (>30 min): #{stuck_count}" if stuck_count > 0
  end
end
